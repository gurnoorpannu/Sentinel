import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    fileParallelism: false,
    include: ['apps/**/*.test.ts', 'packages/**/*.test.ts'],
    coverage: {
      reporter: ['text', 'html'],
    },
  },
});
