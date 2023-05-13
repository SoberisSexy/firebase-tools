import { AppSpec } from "./interfaces";
import { EngineMode, getEngine } from "./engine";

function discover(): AppSpec {
  return {
    baseImage: "nodejs18",
    environmentVariables: {
      NODE_ENV: "PRODUCTION",
    },
    installCommand: "npm install",
    buildCommand: "npm run build",
    startCommand: "npm run start",
  };
}

/**
 * Run composer in the specified execution context.
 */
export function run(mode: EngineMode): void {
  const spec = discover();

  const engine = getEngine(mode, spec);
  engine.install();
  engine.build();
}
