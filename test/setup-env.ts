// Stub required config env vars before modules under test are imported.
process.env.AUSLAW_BASE_URL ??= 'https://example.invalid';
process.env.ISAACUS_API_KEY ??= 'test-key';
process.env.NODE_ENV ??= 'test';
process.env.LOG_LEVEL ??= 'error';
