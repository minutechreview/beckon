// Runs in every test worker before the test file's imports.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://beckon:beckon@localhost:5432/beckon_test";
process.env.AUTH_SECRET = "test-secret-test-secret-test-secret";
