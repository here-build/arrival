import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Tests are co-located next to sources (no __tests__/ dir), so include is broad.
    // No __research__/__benchmarks__/__custdev__ categories in this package.
    include: ["src/**/*.test.{ts,tsx}"],
    testTimeout: 120000, // 2 minutes for slow TS operations
    hookTimeout: 60000,
    teardownTimeout: 60000,
    fileParallelism: false, // Run test files sequentially to avoid worker timeout
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      exclude: [
        'node_modules/',
        'dist/',
        'src/cli.ts',
        '**/*.d.ts',
        '**/*.test.ts'
      ]
    }
  }
});
