import { readJson, type Tree } from '@nx/devkit';
import type { Options } from 'prettier';

let prettier: typeof import('prettier');
try {
  prettier = require('prettier');
} catch {}

export interface ExistingPrettierConfig {
  sourceFilepath: string;
  config: Options;
}

export async function resolveUserExistingPrettierConfig(): Promise<ExistingPrettierConfig | null> {
  if (!prettier) {
    return null;
  }
  try {
    const filepath = await prettier.resolveConfigFile();
    if (!filepath) {
      return null;
    }

    const config = await prettier.resolveConfig(process.cwd(), {
      useCache: false,
      config: filepath,
    });
    if (!config) {
      return null;
    }

    return {
      sourceFilepath: filepath,
      config: config,
    };
  } catch {
    return null;
  }
}

export async function resolvePrettierConfigPath(
  tree: Tree
): Promise<string | null> {
  if (prettier) {
    const filePath = await prettier.resolveConfigFile();
    if (filePath) {
      return filePath;
    }
  }

  if (!tree) {
    return null;
  }

  // if we haven't find a config file in the file system, we try to find it in the virtual tree
  // https://prettier.io/docs/en/configuration.html
  const prettierrcNameOptions = [
    '.prettierrc',
    '.prettierrc.json',
    '.prettierrc.yml',
    '.prettierrc.yaml',
    '.prettierrc.json5',
    '.prettierrc.js',
    '.prettierrc.cjs',
    '.prettierrc.mjs',
    '.prettierrc.toml',
    'prettier.config.js',
    'prettier.config.cjs',
    'prettier.config.mjs',
  ];

  const filePath = prettierrcNameOptions.find((file) => tree.exists(file));
  if (filePath) {
    return filePath;
  }

  // check the package.json file
  const packageJson = readJson(tree, 'package.json');
  if (packageJson.prettier) {
    return 'package.json';
  }

  // check the package.yaml file
  if (tree.exists('package.yaml')) {
    const { load } = await import('@zkochan/js-yaml');
    const packageYaml = load(tree.read('package.yaml', 'utf-8'));
    if (packageYaml.prettier) {
      return 'package.yaml';
    }
  }

  return null;
}
