#!/bin/bash
# First start of the database only (an empty data volume): lets the app's user create and use one database per clinic
# (TENANT_DB_DRIVER=mysql): every database named <DB_NAME>_<clinic>, nothing else on the server.
set -euo pipefail
mariadb -uroot -p"${MARIADB_ROOT_PASSWORD}" <<SQL
GRANT ALL PRIVILEGES ON \`${MARIADB_DATABASE}\\_%\`.* TO '${MARIADB_USER}'@'%';
FLUSH PRIVILEGES;
SQL
