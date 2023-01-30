import { join, relative, extname } from "path";
import { exit } from "process";
import { execSync, spawnSync } from "child_process";
import { readdirSync, statSync } from "fs";
import { pathToFileURL } from "url";
import { IncomingMessage, ServerResponse } from "http";
import { copyFile, readdir, rm, writeFile } from "fs/promises";
import { mkdirp, pathExists, stat } from "fs-extra";
import * as clc from "colorette";
import * as process from "node:process";
import * as semver from "semver";
import * as glob from "glob";

import { needProjectId } from "../projectUtils";
import { hostingConfig } from "../hosting/config";
import { listSites } from "../hosting/api";
import { getAppConfig, AppPlatform } from "../management/apps";
import { promptOnce } from "../prompt";
import { EmulatorInfo, Emulators, EMULATORS_SUPPORTED_BY_USE_EMULATOR } from "../emulator/types";
import { getCredentialPathAsync } from "../defaultCredentials";
import { getProjectDefaultAccount } from "../auth";
import { formatHost } from "../emulator/functionsEmulatorShared";
import { Constants } from "../emulator/constants";
import { FirebaseError } from "../error";
import { requireHostingSite } from "../requireHostingSite";
import { HostingRewrites } from "../firebaseConfig";
import * as experiments from "../experiments";
import { ensureTargeted } from "../functions/ensureTargeted";
import { implicitInit } from "../hosting/implicitInit";
import { BuildTarget, FrameworkMetadata, FrameworkStatic, readJSON } from "./utils";

// Use "true &&"" to keep typescript from compiling this file and rewriting
// the import statement into a require
const { dynamicImport } = require(true && "../dynamicImport");

export interface Discovery {
  mayWantBackend: boolean;
  publicDirectory: string;
}

export interface BuildResult {
  rewrites?: any[];
  redirects?: any[];
  headers?: any[];
  wantsBackend?: boolean;
}

export interface Framework {
  build: () => Promise<void>;
  generateFilesystemAPI: (...args: any[]) => Promise<void>;
  wantsBackend: () => Promise<boolean>;
}

// TODO pull from @firebase/util when published
interface FirebaseDefaults {
  config?: Object;
  emulatorHosts?: Record<string, string>;
  _authTokenSyncURL?: string;
}

interface FindDepOptions {
  cwd: string;
  depth?: number;
  omitDev: boolean;
}

// These serve as the order of operations for discovery
// E.g, a framework utilizing Vite should be given priority
// over the vite tooling
export const enum FrameworkType {
  Custom = 0, // express
  Monorep, // nx, lerna
  MetaFramework, // next.js, nest.js
  Framework, // angular, react
  Toolchain, // vite
}

export const enum SupportLevel {
  Experimental = "experimental",
  Community = "community-supported",
}

const SupportLevelWarnings = {
  [SupportLevel.Experimental]: clc.yellow(
    `This is an experimental integration, proceed with caution.`
  ),
  [SupportLevel.Community]: clc.yellow(
    `This is a community-supported integration, support is best effort.`
  ),
};

export const FIREBASE_FRAMEWORKS_VERSION = "^0.6.0";
export const FIREBASE_FUNCTIONS_VERSION = "^3.23.0";
export const FIREBASE_ADMIN_VERSION = "^11.0.1";
export const DEFAULT_REGION = "us-central1";
export const NODE_VERSION = parseInt(process.versions.node, 10).toString();

const DEFAULT_FIND_DEP_OPTIONS: FindDepOptions = {
  cwd: process.cwd(),
  omitDev: true,
};

const NPM_COMMAND = process.platform === "win32" ? "npm.cmd" : "npm";

export const WebFrameworks: Array<FrameworkMetadata & { constructor: FrameworkStatic }> = [];

// Require all the directories that way we trip the @webFramework
// decorator which will add to the lookup table
glob(join(__dirname, "**/index.js"), (err, matches) => {
  matches
    .filter(it => it !== __filename)
    .forEach(it => require(it));
});

export function relativeRequire(
  dir: string,
  mod: "@angular-devkit/core"
): typeof import("@angular-devkit/core");
export function relativeRequire(
  dir: string,
  mod: "@angular-devkit/core/node"
): typeof import("@angular-devkit/core/node");
export function relativeRequire(
  dir: string,
  mod: "@angular-devkit/architect"
): typeof import("@angular-devkit/architect");
export function relativeRequire(
  dir: string,
  mod: "@angular-devkit/architect/node"
): typeof import("@angular-devkit/architect/node");
export function relativeRequire(
  dir: string,
  mod: "next/dist/build"
): typeof import("next/dist/build");
export function relativeRequire(
  dir: string,
  mod: "next/dist/server/config"
): typeof import("next/dist/server/config");
export function relativeRequire(
  dir: string,
  mod: "next/constants"
): typeof import("next/constants");
export function relativeRequire(dir: string, mod: "next"): typeof import("next");
export function relativeRequire(dir: string, mod: "vite"): typeof import("vite");
export function relativeRequire(dir: string, mod: "jsonc-parser"): typeof import("jsonc-parser");
// TODO the types for @nuxt/kit are causing a lot of troubles, need to do something other than any
export function relativeRequire(dir: string, mod: "@nuxt/kit"): Promise<any>;
/**
 *
 */
export function relativeRequire(dir: string, mod: string) {
  try {
    const path = require.resolve(mod, { paths: [dir] });
    if (extname(path) === ".mjs") {
      return dynamicImport(pathToFileURL(path).toString());
    } else {
      return require(path);
    }
  } catch (e) {
    const path = relative(process.cwd(), dir);
    console.error(
      `Could not load dependency ${mod} in ${
        path.startsWith("..") ? path : `./${path}`
      }, have you run \`npm install\`?`
    );
    throw e;
  }
}

type DiscoveryResult = FrameworkMetadata & { constructor: FrameworkStatic };
type FrameworkConstructor = Function & FrameworkStatic;

/**
 *
 */
export async function discover(dir: string, warn?: boolean): Promise<undefined|DiscoveryResult>;
export async function discover(dir: string, warn: false, depth: number, parent: FrameworkConstructor): Promise<[number,DiscoveryResult][]>;
export async function discover(dir: string, warn = true, depth = 1, parent: FrameworkConstructor|undefined=undefined): Promise<undefined|DiscoveryResult|[number,DiscoveryResult][]> {
  const frameworksDiscovered = (await Promise.all(WebFrameworks
    .filter(it => it.parent === parent)
    .map(async framework => {
      if (framework.requiredFiles) {
        const requiredFilesExist = await Promise.all(framework.requiredFiles.map(path =>
          new Promise(resolve => 
            glob(join(dir, path), (err, matches) => resolve(matches.length > 0))
          )
        ));
        if (requiredFilesExist.some(it => !it)) return undefined;
      }
      if (framework.dependencies) {
        // TODO parellelize 
        for (const dependency of framework.dependencies) {
          if (typeof dependency === "string") {
            if (!findDependency(dependency, { cwd: dir, depth: 0, omitDev: false })) return undefined;
          } else {
            const { depth = 0, omitDev = false } = dependency;
            const version = findDependency(dependency.name, { cwd: dir, depth, omitDev })?.version;
            if (!version) return undefined;
            if (dependency.version && !semver.satisfies(version, dependency.version)) return undefined;
          }
        }
      }
      if (framework.vitePlugins) {
        const { resolveConfig } = relativeRequire(dir, "vite");
        const viteConfig = await resolveConfig({ root: dir }, "build", "production");
        for (const plugin of framework.vitePlugins) {
          if (!viteConfig.plugins.find(it => it.name === plugin)) return undefined;
        }
      }
      const childDiscovery = await discover(dir, false, depth + 1, framework.constructor);
      return [[depth, framework] as [number, DiscoveryResult], ...childDiscovery];
    }))).flat().filter(it => it).map(it => it!);
  if (parent) return frameworksDiscovered;
  const maxDepth = Math.max(...frameworksDiscovered.map(([depth]) => depth));
  const frameworksAtMaxDepth = frameworksDiscovered
    .map(([depth, framework]) => depth === maxDepth ? framework : undefined)
    .filter(it => it)
    .map(it => it!);
  const frameworkOverrides = frameworksAtMaxDepth
    .map(it => it.override)
    .filter(it => it)
    .map(it => it!)
    .flat();
  const detectedFrameworks = frameworksAtMaxDepth
    .filter(it => !frameworkOverrides.includes(it.constructor));
  if (detectedFrameworks.length > 1) {
    if (warn) console.error("Multiple conflicting frameworks discovered.");
    return;
  }
  if (detectedFrameworks.length === 0) {
    if (warn) console.warn("Could not determine the web framework in use.");
    return;
  }
  return detectedFrameworks[0];
}

function scanDependencyTree(searchingFor: string, dependencies = {}): any {
  for (const [name, dependency] of Object.entries(
    dependencies as Record<string, Record<string, any>>
  )) {
    if (name === searchingFor) return dependency;
    const result = scanDependencyTree(searchingFor, dependency.dependencies);
    if (result) return result;
  }
  return;
}

/**
 *
 */
export function findDependency(name: string, options: Partial<FindDepOptions> = {}) {
  const { cwd, depth = Infinity, omitDev = false } = { ...DEFAULT_FIND_DEP_OPTIONS, ...options };
  const env: any = Object.assign({}, process.env);
  delete env.NODE_ENV;
  const result = spawnSync(
    NPM_COMMAND,
    [
      "list",
      name,
      "--json",
      ...(omitDev ? ["--omit", "dev"] : []),
      ...(depth === Infinity ? [] : ["--depth", depth.toString(10)]),
    ],
    { cwd, env }
  );
  if (!result.stdout) return;
  const json = JSON.parse(result.stdout.toString());
  return scanDependencyTree(name, json.dependencies);
}

/**
 *
 */
export async function prepareFrameworks(
  targetNames: string[],
  context: any,
  options: any,
  emulators: EmulatorInfo[] = []
): Promise<void> {
  // `firebase-frameworks` requires Node >= 16. We must check for this to avoid horrible errors.
  const nodeVersion = process.version;
  if (!semver.satisfies(nodeVersion, ">=16.0.0")) {
    throw new FirebaseError(
      `The frameworks awareness feature requires Node.JS >= 16 and npm >= 8 in order to work correctly, due to some of the downstream dependencies. Please upgrade your version of Node.JS, reinstall firebase-tools, and give it another go.`
    );
  }

  const project = needProjectId(context);
  const { projectRoot } = options;
  const account = getProjectDefaultAccount(projectRoot);
  // options.site is not present when emulated. We could call requireHostingSite but IAM permissions haven't
  // been booted up (at this point) and we may be offline, so just use projectId. Most of the time
  // the default site is named the same as the project & for frameworks this is only used for naming the
  // function... unless you're using authenticated server-context TODO explore the implication here.

  // N.B. Trying to work around this in a rush but it's not 100% clear what to do here.
  // The code previously injected a cache for the hosting options after specifying site: project
  // temporarily in options. But that means we're caching configs with the wrong
  // site specified. As a compromise we'll do our best to set the correct site,
  // which should succeed when this method is being called from "deploy". I don't
  // think this breaks any other situation because we don't need a site during
  // emulation unless we have multiple sites, in which case we're guaranteed to
  // either have site or target set.
  if (!options.site) {
    try {
      await requireHostingSite(options);
    } catch {
      options.site = project;
    }
  }
  const configs = hostingConfig(options);
  let firebaseDefaults: FirebaseDefaults | undefined = undefined;
  if (configs.length === 0) {
    return;
  }
  for (const config of configs) {
    const { source: sourcePath, site, public: publicPath } = config;
    if (!sourcePath) {
      continue;
    }
    if (publicPath) {
      throw new Error(`hosting.public and hosting.source cannot both be set in firebase.json`);
    }
    config.cleanUrls ??= true;
    const dist = join(projectRoot, ".firebase", site);
    const hostingDist = join(dist, "hosting");
    const functionsDist = join(dist, "functions");
    const sourceDir = join(projectRoot, sourcePath);
    const functionName = `ssr${site.toLowerCase().replace(/-/g, "")}`;
    const usesFirebaseAdminSdk = !!findDependency("firebase-admin", { cwd: sourceDir });
    const usesFirebaseJsSdk = !!findDependency("@firebase/app", { cwd: sourceDir });
    if (usesFirebaseAdminSdk) {
      process.env.GOOGLE_CLOUD_PROJECT = project;
      if (account && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
        const defaultCredPath = await getCredentialPathAsync(account);
        if (defaultCredPath) process.env.GOOGLE_APPLICATION_CREDENTIALS = defaultCredPath;
      }
    }
    emulators.forEach((info) => {
      if (usesFirebaseAdminSdk) {
        if (info.name === Emulators.FIRESTORE)
          process.env[Constants.FIRESTORE_EMULATOR_HOST] = formatHost(info);
        if (info.name === Emulators.AUTH)
          process.env[Constants.FIREBASE_AUTH_EMULATOR_HOST] = formatHost(info);
        if (info.name === Emulators.DATABASE)
          process.env[Constants.FIREBASE_DATABASE_EMULATOR_HOST] = formatHost(info);
        if (info.name === Emulators.STORAGE)
          process.env[Constants.FIREBASE_STORAGE_EMULATOR_HOST] = formatHost(info);
      }
      if (usesFirebaseJsSdk && EMULATORS_SUPPORTED_BY_USE_EMULATOR.includes(info.name)) {
        firebaseDefaults ||= {};
        firebaseDefaults.emulatorHosts ||= {};
        firebaseDefaults.emulatorHosts[info.name] = formatHost(info);
      }
    });
    let firebaseConfig = null;
    if (usesFirebaseJsSdk) {
      const sites = await listSites(project);
      const selectedSite = sites.find((it) => it.name && it.name.split("/").pop() === site);
      if (selectedSite) {
        const { appId } = selectedSite;
        if (appId) {
          firebaseConfig = await getAppConfig(appId, AppPlatform.WEB);
          firebaseDefaults ||= {};
          firebaseDefaults.config = firebaseConfig;
        } else {
          const defaultConfig = await implicitInit(options);
          if (defaultConfig.json) {
            console.warn(
              `No Firebase app associated with site ${site}, injecting project default config.
  You can link a Web app to a Hosting site here https://console.firebase.google.com/project/${project}/settings/general/web`
            );
            firebaseDefaults ||= {};
            firebaseDefaults.config = JSON.parse(defaultConfig.json);
          } else {
            // N.B. None of us know when this can ever happen and the deploy would
            // still succeed. Maaaaybe if someone tried calling firebase serve
            // on a project that never initialized hosting?
            console.warn(
              `No Firebase app associated with site ${site}, unable to provide authenticated server context.
  You can link a Web app to a Hosting site here https://console.firebase.google.com/project/${project}/settings/general/web`
            );
            if (!options.nonInteractive) {
              const continueDeploy = await promptOnce({
                type: "confirm",
                default: true,
                message: "Would you like to continue with the deploy?",
              });
              if (!continueDeploy) exit(1);
            }
          }
        }
      }
    }
    if (firebaseDefaults) process.env.__FIREBASE_DEFAULTS__ = JSON.stringify(firebaseDefaults);
    const results = await discover(sourceDir);
    if (!results) throw new Error("Epic fail.");
    const {
      constructor: { initialize },
      name,
      support,
      analyticsKey,
    } = results;
    console.log(`Detected a ${name} codebase. ${SupportLevelWarnings[support] || ""}\n`);

    const framework = await initialize(sourceDir, options);

    await framework.build();

    if (await pathExists(hostingDist)) await rm(hostingDist, { recursive: true });
    await mkdirp(hostingDist);
    config.public = relative(projectRoot, hostingDist);

    const wantsBackend = await framework.wantsBackend();

    config.webFramework = `${analyticsKey}${wantsBackend ? "_ssr" : ""}`;

    if (wantsBackend) {
      // if exists, delete everything but the node_modules directory and package-lock.json
      // this should speed up repeated NPM installs
      if (await pathExists(functionsDist)) {
        const functionsDistStat = await stat(functionsDist);
        if (functionsDistStat?.isDirectory()) {
          const files = await readdir(functionsDist);
          for (const file of files) {
            if (file !== "node_modules" && file !== "package-lock.json")
              await rm(join(functionsDist, file), { recursive: true });
          }
        } else {
          await rm(functionsDist);
        }
      } else {
        await mkdirp(functionsDist);
      }
    }

    await framework.generateFilesystemAPI(BuildTarget.FirebaseHosting, {
      hosting: { destinationDir: hostingDist },
      functions: { destinationDir: functionsDist },
    });

    if (wantsBackend) {
      if (firebaseDefaults) firebaseDefaults._authTokenSyncURL = "/__session";

      const rewrite: HostingRewrites = {
        source: "**",
        function: {
          functionId: functionName,
        },
      };
      if (experiments.isEnabled("pintags")) {
        rewrite.function.pinTag = true;
      }
      config.rewrites ||= [];
      config.rewrites.push(rewrite);

      const codebase = `firebase-frameworks-${site}`;
      const existingFunctionsConfig = options.config.get("functions")
        ? [].concat(options.config.get("functions"))
        : [];
      options.config.set("functions", [
        ...existingFunctionsConfig,
        {
          source: relative(projectRoot, functionsDist),
          codebase,
        },
      ]);

      if (!targetNames.includes("functions")) {
        targetNames.unshift("functions");
      }
      if (options.only) {
        options.only = ensureTargeted(options.only, codebase);
      }

      await writeFile(
        join(functionsDist, "functions.yaml"),
        JSON.stringify({
          endpoints: {
            [functionName]: {
              platform: "gcfv2",
              // TODO allow this to be configurable
              region: [DEFAULT_REGION],
              labels: {},
              httpsTrigger: {},
              entryPoint: "ssr",
            },
          },
          specVersion: "v1alpha1",
          requiredAPIs: [],
        })
      );

      const packageJson = await readJSON(join(functionsDist, "package.json"));
      packageJson.main = "server.js";
      delete packageJson.devDependencies;
      packageJson.dependencies ||= {};
      packageJson.dependencies["firebase-frameworks"] ||= FIREBASE_FRAMEWORKS_VERSION;
      packageJson.dependencies["firebase-functions"] ||= FIREBASE_FUNCTIONS_VERSION;
      packageJson.dependencies["firebase-admin"] ||= FIREBASE_ADMIN_VERSION;
      packageJson.engines ||= {};
      packageJson.engines.node ||= NODE_VERSION;

      await writeFile(join(functionsDist, "package.json"), JSON.stringify(packageJson, null, 2));

      // TODO do we add the append the local .env?
      await writeFile(
        join(functionsDist, ".env"),
        `__FIREBASE_FRAMEWORKS_ENTRY__=next.js
${firebaseDefaults ? `__FIREBASE_DEFAULTS__=${JSON.stringify(firebaseDefaults)}\n` : ""}`
      );

      if (await pathExists(join(sourceDir, ".npmrc"))) {
        await copyFile(join(sourceDir, ".npmrc"), join(functionsDist, ".npmrc"));
      }

      execSync(`${NPM_COMMAND} i --omit dev --no-audit`, {
        cwd: functionsDist,
        stdio: "inherit",
      });

      // if (bootstrapScript) await writeFile(join(functionsDist, "bootstrap.js"), bootstrapScript);

      // TODO move to templates
      await writeFile(
        join(functionsDist, "server.js"),
        `const { onRequest } = require('firebase-functions/v2/https');
const server = import('firebase-frameworks');
exports.ssr = onRequest((req, res) => server.then(it => it.handle(req, res)));
`
      );
    }

    if (firebaseDefaults) {
      const encodedDefaults = Buffer.from(JSON.stringify(firebaseDefaults)).toString("base64url");
      const expires = new Date(new Date().getTime() + 60_000_000_000);
      const sameSite = "Strict";
      const path = `/`;
      config.headers ||= [];
      config.headers.push({
        source: "**/*.js",
        headers: [
          {
            key: "Set-Cookie",
            value: `__FIREBASE_DEFAULTS__=${encodedDefaults}; SameSite=${sameSite}; Expires=${expires.toISOString()}; Path=${path};`,
          },
        ],
      });
    }
  }
}

/**
 *
 */
export function createServerResponseProxy(
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void
) {
  const proxiedRes = new ServerResponse(req);
  const buffer: [string, any[]][] = [];
  proxiedRes.write = new Proxy(proxiedRes.write.bind(proxiedRes), {
    apply: (target: any, thisArg, args) => {
      target.call(thisArg, ...args);
      buffer.push(["write", args]);
    },
  });
  proxiedRes.setHeader = new Proxy(proxiedRes.setHeader.bind(proxiedRes), {
    apply: (target: any, thisArg, args) => {
      target.call(thisArg, ...args);
      buffer.push(["setHeader", args]);
    },
  });
  proxiedRes.removeHeader = new Proxy(proxiedRes.removeHeader.bind(proxiedRes), {
    apply: (target: any, thisArg, args) => {
      target.call(thisArg, ...args);
      buffer.push(["removeHeader", args]);
    },
  });
  proxiedRes.writeHead = new Proxy(proxiedRes.writeHead.bind(proxiedRes), {
    apply: (target: any, thisArg, args) => {
      target.call(thisArg, ...args);
      buffer.push(["writeHead", args]);
    },
  });
  proxiedRes.end = new Proxy(proxiedRes.end.bind(proxiedRes), {
    apply: (target: any, thisArg, args) => {
      target.call(thisArg, ...args);
      if (proxiedRes.statusCode === 404) {
        next();
      } else {
        for (const [fn, args] of buffer) {
          (res as any)[fn](...args);
        }
        res.end(...args);
      }
    },
  });
  return proxiedRes;
}
