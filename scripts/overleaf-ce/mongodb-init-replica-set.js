/* global rs */
// Runs once, on an empty data directory. CE needs a replica set for MongoDB transactions.
rs.initiate({ _id: 'overleaf', members: [{ _id: 0, host: 'mongo:27017' }] })
