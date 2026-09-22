import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify('test'),
    __APP_BUILD__: JSON.stringify('test'),
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
