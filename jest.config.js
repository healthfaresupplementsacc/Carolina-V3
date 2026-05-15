'use strict';

module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.js'],
  testPathIgnorePatterns: ['/node_modules/'],
  collectCoverageFrom: [
    'src/**/*.js',
    '!src/dashboard/template.js',
    '!src/index.js',
  ],
  verbose: false,
  testTimeout: 10000,
};
