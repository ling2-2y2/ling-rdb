// One-off out-of-band bootstrap (not consumer code): create the dedicated
// test database dsh_rbac_test on the shared MySQL instance. Run from the
// dsh-rdb-mysql directory so its bundled mysql2 resolves.
'use strict'
require('mysql2/promise').createConnection({
  host: '192.168.74.129',
  port: 3307,
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
}).then(async connection => {
  await connection.query('CREATE DATABASE IF NOT EXISTS dsh_rbac_test CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci')
  console.log('dsh_rbac_test ready')
  await connection.end()
}).catch(error => {
  console.error('bootstrap failed:', error.message)
  process.exit(1)
})
