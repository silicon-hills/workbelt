import * as t from 'io-ts';
import Handlebars from 'handlebars';
import YAML from 'yaml';
import fs from 'fs-extra';
import glob from 'glob';
import path from 'path';
import { PathReporter } from 'io-ts/PathReporter';
import { HashMap } from '~/types';

export const Dependency = t.type({
  autoinstall: t.union([t.undefined, t.boolean]),
  depends_on: t.union([t.undefined, t.array(t.string)]),
  description: t.union([t.undefined, t.string]),
  detect: t.union([t.undefined, t.string]),
  install: t.union([t.undefined, t.string]),
  instructions: t.union([t.undefined, t.string]),
  open: t.union([t.undefined, t.boolean]),
  resources: t.union([t.undefined, t.array(t.string)]),
  sudo: t.union([t.undefined, t.boolean])
});
export type Dependency = t.TypeOf<typeof Dependency>;
export interface LoadedDependency extends Omit<Dependency, 'sudo'> {
  _cwd: string;
  _name: string;
  sudo: boolean;
}

export const System = t.record(
  t.string,
  t.union([t.null, t.string, Dependency])
);
export type System = t.TypeOf<typeof System>;
export interface LoadedSystem {
  [key: string]: LoadedDependency;
}
export type Dependencies = LoadedSystem;

export const Systems = t.record(t.string, t.union([t.null, System]));
export type Systems = t.TypeOf<typeof Systems>;
export interface LoadedSystems {
  [key: string]: LoadedSystem;
}

export const Config = t.type({
  autoinstall: t.union([t.undefined, t.boolean]),
  includes: t.union([t.undefined, t.array(t.string)]),
  name: t.union([t.undefined, t.string]),
  systems: Systems
});
export type Config = t.TypeOf<typeof Config>;
export interface LoadedConfig extends Omit<Config, 'systems'> {
  systems: LoadedSystems;
}

export class ConfigLoader {
  private loaded = new Set<string>();

  private recursiveTemplate(str: string, data: HashMap<string> = {}) {
    const result = Handlebars.compile(str)({
      ...data,
      ...YAML.parse(str),
      env: process.env
    });
    if (result === str) return result;
    return this.recursiveTemplate(result, data);
  }

  private getIncludes(globs: string[] = []) {
    return globs.reduce((includes: string[], globStr: string) => {
      includes = [...includes, ...glob.sync(globStr)];
      return includes;
    }, []);
  }

  load(config: string | Config, cwd = process.cwd()): LoadedConfig {
    let configObj = config as Config;
    if (typeof config === 'string') {
      this.loaded.add(config);
      const configStr = fs.readFileSync(config).toString();
      configObj = YAML.parse(this.recursiveTemplate(configStr));
    }
    validate(configObj, Config);
    const includes = this.getIncludes(configObj.includes);
    const loadedSystems = this.loadSystems(configObj.systems, cwd);
    const loadedConfig = {
      ...configObj,
      systems: loadedSystems
    };
    return (includes as any[]).reduce(
      (loadedConfig: LoadedConfig, includePath: string) => {
        if (this.loaded.has(includePath)) return loadedConfig;
        this.loaded.add(includePath);
        const configLoader = new ConfigLoader();
        const config = configLoader.load(
          includePath,
          path.resolve(cwd, includePath.replace(/[^/]*$/g, ''))
        );
        return {
          ...loadedConfig,
          systems: Object.entries(config.systems).reduce(
            (
              loadedSystems: LoadedSystems,
              [systemName, loadedSystem]: [string, LoadedSystem]
            ) => {
              loadedSystems[systemName] = {
                ...(loadedSystems[systemName] || {}),
                ...loadedSystem
              };
              return loadedSystems;
            },
            loadedConfig.systems
          )
        } as LoadedConfig;
      },
      loadedConfig
    );
  }

  private loadSystems(systems: Systems, cwd: string): LoadedSystems {
    return Object.entries(systems).reduce<LoadedSystems>(
      (
        loadedSystems: LoadedSystems,
        [systemName, system]: [string, System | null]
      ) => {
        if (system) {
          loadedSystems[systemName] = this.loadSystem(system, cwd);
        }
        return loadedSystems;
      },
      {}
    );
  }

  private loadSystem(system: System, cwd: string): LoadedSystem {
    return Object.entries(system).reduce<LoadedSystem>(
      (
        loadedSystem: LoadedSystem,
        [dependencyName, dependency]: [string, string | Dependency | null]
      ) => {
        if (dependency) {
          loadedSystem[dependencyName] = this.loadDependency(
            dependency,
            dependencyName,
            cwd
          );
        }
        return loadedSystem;
      },
      {}
    );
  }

  private loadDependency(
    dependency: Dependency | string,
    dependencyName: string,
    cwd: string
  ): LoadedDependency {
    if (typeof dependency === 'string') {
      if (/^https?:\/\//g.test(dependency)) {
        return {
          _cwd: cwd,
          _name: dependencyName,
          autoinstall: false,
          depends_on: undefined,
          description: undefined,
          detect: undefined,
          install: undefined,
          instructions: undefined,
          open: true,
          resources: [dependency],
          sudo: false
        };
      }
      return {
        _cwd: cwd,
        _name: dependencyName,
        autoinstall: true,
        depends_on: undefined,
        description: undefined,
        detect: undefined,
        install: dependency,
        instructions: undefined,
        open: undefined,
        resources: undefined,
        sudo: false
      };
    }
    return {
      autoinstall: true,
      open: true,
      ...dependency,
      sudo: !!dependency.sudo,
      _cwd: cwd,
      _name: dependencyName
    };
  }
}

export function validate<T = any>(value: T, Type: t.Type<any>) {
  const errors = PathReporter.report(Type.decode(value));
  const message = errors.join('; ');
  if (message === 'No errors!') return;
  throw new Error(message);
}
