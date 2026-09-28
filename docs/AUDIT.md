# Implementation audit — DocBook rebuilt on the RemoteWay-grade UX system

This audit was written from the two supplied codebases before any code was changed.

| Input | What it actually contains |
|---|---|
| `remoteway-1.0.0-rc.4.zip` | Full source. Node 20, Express 4, server-rendered EJS, knex + MySQL, no build step, strict CSP, cPanel-friendly. |
| `dist-DocBook-payroll_1.zip` | A **built** bundle only. `server.cjs.map` holds the full server source (24 TypeScript files, ~15k lines), so the server is recoverable exactly. The React client is minified only (`App-*.js`, 2.5 MB). I pretty-printed it and read the business logic from it (engine functions `F$`, `I$`, `P$`, the order-commission code, the Google Sheets sync and the Apps Script, the EN/AR dictionaries). |

---

## 1. RemoteWay architecture reused (presentation and infrastructure only)

| Area | Reused as |
|---|---|
| App skeleton | `app.js → src/server.js → src/app.js`, boot with a MySQL named lock, auto-migrate, and a setup-error page when the app can't start |
| Request pipeline | helmet CSP, compression, MySQL-backed `express-session`, `res.page(view, {layout})` view-in-layout rendering, `loadUser → locals → csrf` |
| Errors | `AppError` + `E.*` codes, the `form()` helper that re-renders a form with field errors, and one JSON/HTML error handler |
| Validation | zod `validate()` with per-field messages, translated in AR through a `vmsg` table |
| Tenancy | Workspace comes from a verified membership, never from request input. `req.ctx` is passed to every service. |
| RBAC | permissions → roles → user_roles tables, a cached permission set per member, `can()` middleware and a `can()` view helper |
| Audit trail | `audit_logs` with old/new diffs and secret scrubbing |
| i18n | JSON dictionaries, `t(key, vars)`, and locale taken from query, cookie, user and then `Accept-Language` |
| Security | CSRF synchronizer token, rate-limited login, bcrypt, password-reset tokens (sha256), sessions ended on password change, SSRF-safe outbound HTTP, AES-256-GCM credential encryption |
| UI system | Semantic CSS tokens, light/dark (`system`/manual/persisted cookie), logical properties for RTL, sidebar + topbar shell, off-canvas mobile nav, `details` dropdowns, native `<dialog>` modals, confirm dialogs for destructive forms, auto-submit filters, column toggles, a Ctrl/⌘K palette, server-rendered SVG charts with a tooltip hit-layer, KPI strips, panels, tables, badges, empty states and skeletons, wizard steps, a print layout |
| Exports | CSV with a BOM and formula-injection protection |
| AI | Provider adapters (Anthropic / OpenAI / Gemini / Azure) behind the SSRF-safe client, with encrypted keys |

Not reused: the brand assets (logos, `#1ACC6C` palette, Montserrat files), `site.*` marketing copy, and any HR/recruitment view.

## 2. DocBook modules found

The server source is a multi-tenant platform. The **business-finance hub** (the EN dictionary calls it "Smart Business & Partner Finance Hub") is the module set the brief describes:

| Module | Data (table in DocBook) | Notes |
|---|---|---|
| Projects / branches | `app_projects` (name, code, currency, color, spreadsheet) | multi-branch; each user can be limited to `allowedProjectIds` |
| Partners | `app_partners` (initial_investment, additional_contributions, total_withdrawn, current_equity_percent, join_date, notes) | equity must total 100 % |
| Expenses | `app_expenses` (date, category, title, amount, payment_method, invoice_number, recorded_by, notes) | 11 categories, 4 payment methods |
| Payroll | `app_employees` (base_salary, commission_type `percentage`/`fixed_per_order`, commission_rate, region_commission_rates, bonus, deductions, status `active`/`on_leave`/`inactive`, hire_date, bank_account, **paid_months[]**) | |
| Purchases / COGS | `app_purchases` (supplier, item, sku, category, unit_cost, quantity, total_cost, shipping_cost, paid_amount, payment_status `paid`/`partial`/`due`) | |
| Marketing | `app_campaigns` (platform ×8, dates, cost, impressions, clicks, conversions, revenue_generated, status) | |
| Sales / CRM | `app_manual_orders` (items[] {itemName, quantity, unitPrice, unitCost}, subtotal, discount, delivery_fee, total, total_cogs, employee_id, commission_earned, courier, delivery_cost, payment_status ×4, channel) + customers (name, phone, email, city, region, group, totalSpent, ordersCount) | invoice numbering: prefix + next number |
| Delivery | `app_deliveries` (order_id, courier company/name/phone, tracking, recipient, city, fee_paid, fee_collected, status ×5, cash_remitted) | |
| Budgets | `app_budgets` (category, monthly_budget, alert_threshold_percent, period_month) | virtual categories: marketing, delivery, inventory_purchase, payroll |
| Support | `app_tickets` (number, title, category ×5, priority ×4, status ×3, messages[]) + 4 FAQ entries | |
| Google Sheets | `app_project_settings.sheets_*`, an Apps Script web-app webhook (push/pull) and an optional OAuth-token Sheets v4 path | the OAuth path has no working token source in the shipped build |
| AI CFO advisor | `/api/ai/advisor` and `/api/ai/chat` (Gemini) | **returns canned text when no key is set** — replaced (see §8) |
| Reports | P&L (10 lines), partner slips, payroll, marketing, Excel workbook, JSON backup/restore | |
| Users | flag permissions: canViewProfits, canManagePartners, canManageExpenses, canManagePayroll, canManagePurchases, canManageMarketing, canManageOrders, canManageDeliveries, canSyncSheets, canManageProjects, canManageUsers (+products/storefront) | roles admin / accountant / sales / partner_viewer |

**Also present in DocBook but outside this rebuild's brief:** the clinic system (appointments, doctors, patients, prescriptions — `healthcare.ts`), the storefront website builder (`storefront.ts`), email/SMS marketing campaigns, and super-admin tenancy/plans. None of these appear in the brief's module list A–L. They are **not** ported in this pass, and nothing in the original DocBook is deleted. See §8.

## 3. DocBook business logic preserved (ported verbatim into `src/modules/finance/engine.js`)

- **Period filter**: `toMonthKey()` (the `y7` function) normalises `YYYY-MM-DD`, `DD/MM/YYYY` and `MM/DD/YYYY` dates to `YYYY-MM`. Campaigns match on start **or** end month.
- **Revenue** = Σ order.totalAmount. **COGS** = Σ order.totalCogs. **Gross profit** = revenue − COGS.
- **Daily OPEX** = expenses whose category is not `marketing`, `salaries` or `deliveries`. This avoids double counting.
- **Salaries**: for each employee that is not `inactive`, the salary is base + bonus − deductions. It counts only if the month is in `paidMonths`. With no period set, it is multiplied by the number of paid months.
- **Commissions** = Σ order.commissionEarned. **Payroll** = salaries + commissions.
- **Payroll obligation** = Σ active monthly (base + bonus − deductions) + commissions.
- **Marketing** = Σ campaign.cost.
- **Delivery cost** = Σ shipment.deliveryFeePaid + Σ order.deliveryCost for orders that have **no** shipment record.
- **Inventory**: paid = Σ paidAmount. Commitment = Σ (totalCost + shippingCost). Due = max(0, commitment − paid).
- **Operating expenses** = OPEX + payroll + marketing + delivery + financing. **Net profit** = gross profit − operating expenses.
- **Cash outflow** = OPEX + payroll + marketing + delivery + inventory paid + financing.
- **Partner allocation** = netProfit × equity%. Net payable = initial + additional + allocation − withdrawn.
- **Campaign metrics**: ROAS = revenue/cost, ROI = (revenue − cost)/cost×100, CPC, CPA, CTR, profit.
- **Budget status**: spend depends on the category (marketing → campaigns, delivery → shipment fees paid, inventory_purchase → purchases paid, payroll → salaries + commissions, otherwise expenses in that category). The result is warning when ≥ threshold and exceeded when > limit.
- **Order commission**: uses the region rate if the customer's region has one, otherwise the employee's rate. Percentage → total × rate / 100; fixed → rate per order. Total = max(0, subtotal − discount + deliveryFee). COGS = Σ unitCost × qty.
- **Invoice numbers**: prefix + next number, claimed atomically.
- Status vocabularies, categories, payment methods and platforms are kept exactly as keys.

## 4. RemoteWay-specific functionality NOT carried over

HR/ATS/recruitment, candidates, jobs board, talent marketplace, careers pages, attendance, leave, employee onboarding plans, documents, tasks, performance/OKRs, learning, GOSI/WPS/Saudi labour compliance, country policy engine, automation rules, SSO, subscription plans/billing/Saudi payment gateways, the internal RemoteWay CRM (WhatsApp/Taqnyat), white-label domains, super-admin platform, all RemoteWay copy, logos, fonts, colours, URLs and demo data. The only word both products share is "payroll", and the payroll here is DocBook's (salary + commission + paid months), not RemoteWay's GOSI engine.

## 5. Final navigation

Organised from DocBook's real modules:

- **Overview** — Dashboard
- **Finance** — Partners · Expenses · Payroll · Budgets & alerts
- **Operations** — Sales & orders · Customers · Purchases & COGS · Delivery
- **Growth** — Marketing
- **Intelligence** — Reports · AI financial advisor
- **Workspace** — Google Sheets · Support · Settings

Every item is gated by permission, so a module the user can't use never appears in the nav or ⌘K.

## 6. Application architecture

```
app.js                      cPanel entry
src/config/brand.js         ← the single brand/theme configuration
src/server.js, src/app.js   boot, CSP, sessions, render pipeline
src/core/                   errors, validate, i18n, audit, csv, xlsx, charts, format, money, secrets, http, cache
src/db/migrations/          one schema, all business tables carry business_id
src/middleware/             context (auth, tenant, permissions), web (locals, csrf, flash), errors
src/modules/<module>/       *.service.js (data + rules)  web.js (routes)  views under src/views/pages/<module>
src/modules/finance/engine.js   DocBook calculation engine (pure functions, unit-tested)
public/                     app.css (token-only), app.js (progressive enhancement), icons.svg, brand/
```

DocBook's single "save the whole snapshot" endpoint (delete-all + insert-all on every save) is replaced by per-record CRUD with an audit trail. The same JSON snapshot shape stays supported for **export, restore and one-time import from DocBook**.

## 7. Theme / branding architecture

- `src/config/brand.js` holds the product name, tagline, logo, logo-on-dark, favicon, font stack, and the light and dark palettes (primary, primary-hover, secondary, accent, background, surface, surface-muted, text, text-muted, border, success, warning, danger, info).
- `/theme.css` is generated from that file into CSS custom properties. `public/css/app.css` contains **no hex colours**, only `var(--…)`.
- Per-workspace override (Settings → Appearance): primary colour and logo, served as `/theme/<business>.css` (CSP-safe, no inline styles).
- Charts, print layout and PDFs read the same tokens.

## 8. Migration risks and decisions

| Risk | Decision |
|---|---|
| DocBook client source is minified only | Logic was read from the bundle and ported with tests that pin the formulas |
| DocBook USD projects **store JOD values and multiply by a rate on display** | New product stores and shows amounts in the business currency. The DocBook import offers to convert a USD project's amounts with the configured rate. |
| Canned AI answers when no key is set (fake data) | Removed. Without a provider, the advisor shows deterministic, rule-based findings computed from real data and says clearly that AI is not configured. |
| Snapshot save semantics (delete + reinsert) could silently overwrite | Per-record writes; destructive actions need confirmation + permission + audit. Restore requires typing the workspace name. |
| Google Sheets OAuth token path has no token source | The working Apps-Script webhook path is kept (server-side now, so real HTTP status is visible), with the Apps Script provided in-app, plus a sync log. |
| Salaries use *current* employee values for past paid months | Kept for parity. Each "mark paid" also stores a snapshot row for payslips/history. |
| Clinic / storefront / email-marketing subsystems | Out of scope of the brief's A–L list; documented, not ported, original untouched |

## 9. Implementation order

1. Brand config, tokens, CSS, icons, shell (sidebar, topbar, ⌘K, theme, language)
2. Schema + auth + workspace + RBAC
3. Finance engine + unit tests
4. Modules: Dashboard → Partners → Expenses → Payroll → Purchases → Sales/Customers → Delivery → Marketing → Budgets → Reports → Sheets → AI → Support
5. Onboarding, settings, users/roles, backup/restore/DocBook import
6. Landing page
7. QA: integration tests on MySQL, screenshots (light/dark, AR/EN, mobile), brand-leak scan
