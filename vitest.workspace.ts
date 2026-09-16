import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  {
    test: {
      name: 'unit',
      include: ['test/unit/**/*.test.ts'],
      environment: 'node',
    },
  },
  {
    test: {
      name: 'property',
      include: ['test/property/**/*.test.ts'],
      environment: 'node',
    },
  },
  {
    test: {
      name: 'integration',
      include: ['test/integration/**/*.test.ts'],
      environment: 'node',
    },
  },
]);
