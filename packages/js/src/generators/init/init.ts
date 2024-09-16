import {
  addDependenciesToPackageJson,
  createProjectGraphAsync,
  ensurePackage,
  formatFiles,
  generateFiles,
  GeneratorCallback,
  readJson,
  readNxJson,
  stripIndents,
  Tree,
  updateJson,
  writeJson,
} from '@nx/devkit';
import { addPlugin } from '@nx/devkit/src/utils/add-plugin';
import { checkAndCleanWithSemver } from '@nx/devkit/src/utils/semver';
import { readModulePackageJson } from 'nx/src/utils/package-json';
import { join } from 'path';
import { satisfies, valid } from 'semver';
import { createNodesV2 } from '../../plugins/typescript/plugin';
import { getRootTsConfigFileName } from '../../utils/typescript/ts-config';
import {
  nxVersion,
  prettierVersion,
  supportedTypescriptVersions,
  swcCoreVersion,
  swcHelpersVersion,
  swcNodeVersion,
  typescriptVersion,
} from '../../utils/versions';
import { InitSchema } from './schema';

async function getInstalledTypescriptVersion(
  tree: Tree
): Promise<string | null> {
  const rootPackageJson = readJson(tree, 'package.json');
  const tsVersionInRootPackageJson =
    rootPackageJson.devDependencies?.['typescript'] ??
    rootPackageJson.dependencies?.['typescript'];

  if (!tsVersionInRootPackageJson) {
    return null;
  }
  if (valid(tsVersionInRootPackageJson)) {
    // it's a pinned version, return it
    return tsVersionInRootPackageJson;
  }

  // it's a version range, check whether the installed version matches it
  try {
    const tsPackageJson = readModulePackageJson('typescript').packageJson;
    const installedTsVersion =
      tsPackageJson.devDependencies?.['typescript'] ??
      tsPackageJson.dependencies?.['typescript'];
    // the installed version matches the package.json version range
    if (
      installedTsVersion &&
      satisfies(installedTsVersion, tsVersionInRootPackageJson)
    ) {
      return installedTsVersion;
    }
  } finally {
    return checkAndCleanWithSemver('typescript', tsVersionInRootPackageJson);
  }
}

export async function initGenerator(
  tree: Tree,
  schema: InitSchema
): Promise<GeneratorCallback> {
  return initGeneratorInternal(tree, {
    addTsConfigBase: true,
    setUpPrettier: true,
    addPlugin: false,
    ...schema,
  });
}

export async function initGeneratorInternal(
  tree: Tree,
  schema: InitSchema
): Promise<GeneratorCallback> {
  const tasks: GeneratorCallback[] = [];

  const nxJson = readNxJson(tree);
  schema.addPlugin ??=
    process.env.NX_ADD_PLUGINS !== 'false' &&
    nxJson.useInferencePlugins !== false;
  const addTsPlugin =
    schema.addPlugin && process.env.NX_ADD_TS_PLUGIN === 'true';

  if (addTsPlugin) {
    await addPlugin(
      tree,
      await createProjectGraphAsync(),
      '@nx/js/typescript',
      createNodesV2,
      {
        typecheck: [
          { targetName: 'typecheck' },
          { targetName: 'tsc:typecheck' },
          { targetName: 'tsc-typecheck' },
        ],
        build: [
          { targetName: 'build', configName: 'tsconfig.lib.json' },
          { targetName: 'tsc:build', configName: 'tsconfig.lib.json' },
          { targetName: 'tsc-build', configName: 'tsconfig.lib.json' },
        ],
      },
      schema.updatePackageScripts
    );
  }

  if (schema.addTsConfigBase && !getRootTsConfigFileName(tree)) {
    if (addTsPlugin) {
      generateFiles(tree, join(__dirname, './files/ts-solution'), '.', {
        tmpl: '',
      });
    } else {
      generateFiles(tree, join(__dirname, './files/non-ts-solution'), '.', {
        fileName: schema.tsConfigName ?? 'tsconfig.base.json',
      });
    }
  }

  const devDependencies = {
    '@nx/js': nxVersion,
    // When loading .ts config files (e.g. webpack.config.ts, jest.config.ts, etc.)
    // we prefer to use SWC, and fallback to ts-node for workspaces that don't use SWC.
    '@swc-node/register': swcNodeVersion,
    '@swc/core': swcCoreVersion,
    '@swc/helpers': swcHelpersVersion,
  };

  if (!schema.js && !schema.keepExistingVersions) {
    const installedTsVersion = await getInstalledTypescriptVersion(tree);

    if (
      !installedTsVersion ||
      !satisfies(installedTsVersion, supportedTypescriptVersions, {
        includePrerelease: true,
      })
    ) {
      devDependencies['typescript'] = typescriptVersion;
    }
  }

  if (schema.setUpPrettier) {
    devDependencies['prettier'] = prettierVersion;

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

    if (prettierrcNameOptions.every((name) => !tree.exists(name))) {
      writeJson(tree, '.prettierrc', {
        singleQuote: true,
      });
    }

    if (!tree.exists(`.prettierignore`)) {
      tree.write(
        '.prettierignore',
        stripIndents`
        # Add files here to ignore them from prettier formatting
        /dist
        /coverage
        /.nx/cache
        /.nx/workspace-data
      `
      );
    }

    if (tree.exists('.vscode/extensions.json')) {
      updateJson(tree, '.vscode/extensions.json', (json) => {
        json.recommendations ??= [];
        const extension = 'esbenp.prettier-vscode';
        if (!json.recommendations.includes(extension)) {
          json.recommendations.push(extension);
        }
        return json;
      });
    }
  }

  const installTask = !schema.skipPackageJson
    ? addDependenciesToPackageJson(
        tree,
        {},
        devDependencies,
        undefined,
        schema.keepExistingVersions
      )
    : () => {};
  tasks.push(installTask);

  if (schema.setUpPrettier) {
    ensurePackage('prettier', prettierVersion);
    if (!schema.skipFormat) await formatFiles(tree);
  }

  return async () => {
    for (const task of tasks) {
      await task();
    }
  };
}

export default initGenerator;
