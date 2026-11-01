// Jest setup: tests never rely on the public example secret or on a missing key.
process.env.WEBHOOK_SECRET ??= 'test-webhook-secret-0123456789abcdef0123456789';
process.env.API_KEY ??= 'test-api-key-0123456789abcdef0123456789abcdef';
