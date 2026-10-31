export interface Config {
  databaseUrl: string;
  testDatabaseUrl: string;
  port: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    databaseUrl: env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/myrxlis_dev',
    testDatabaseUrl: env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/myrxlis_test',
    port: Number(env.PORT ?? 3000),
  };
}
