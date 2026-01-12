import baseConfig from '../../jest.config.js';

const config = {
  ...baseConfig,
  roots: ['<rootDir>/__tests__'],
  setupFilesAfterEnv: ['<rootDir>/../../jest.setup.ts'],
};

export default config;