// Ticket "unread" markers compare the time a member last read a ticket with the ticket's last activity. With whole-second
// columns a reply and a read in the same second can't be ordered, so both keep milliseconds.
exports.up = async (knex) => {
  await knex.raw('ALTER TABLE support_tickets MODIFY last_activity_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)');
  await knex.raw('ALTER TABLE support_ticket_reads MODIFY read_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)');
};

exports.down = async (knex) => {
  await knex.raw('ALTER TABLE support_tickets MODIFY last_activity_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP');
  await knex.raw('ALTER TABLE support_ticket_reads MODIFY read_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP');
};
