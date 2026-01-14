import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // This is for vitest, but vite-node can also use some of these settings
  },
  ssr: {
    noExternal: ['@google/adk', 'lodash']
  }
});
