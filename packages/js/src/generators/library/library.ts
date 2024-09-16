import {
  addDependenciesToPackageJson,
  addProjectConfiguration,
  detectPackageManager,
  ensurePackage,
  formatFiles,
  generateFiles,
  GeneratorCallback,
  getPackageManagerCommand,
  isWorkspacesEnabled,
  joinPathFragments,
  names,
  offsetFromRoot,
  output,
  ProjectConfiguration,
  ProjectGraphProjectNode,
  readJson,
  readNxJson,
  readProjectConfiguration,
  runTasksInSerial,
  toJS,
  Tree,
  updateJson,
  updateProjectConfiguration,
  writeJson,
} from '@nx/devkit';
import { determineProjectNameAndRootOptions } from '@nx/devkit/src/generators/project-name-and-root-utils';
import { addBuildTargetDefaults } from '@nx/devkit/src/generators/target-defaults-utils';
import { logShowProjectCommand } from '@nx/devkit/src/utils/log-show-project-command';
import { prompt } from 'enquirer';
import { minimatch } from 'minimatch';
import { getGlobPatternsFromPackageManagerWorkspaces } from 'nx/src/plugins/package-json';
import { findMatchingProjects } from 'nx/src/utils/find-matching-projects';
import { isCI } from 'nx/src/utils/is-ci';
import { type PackageJson } from 'nx/src/utils/package-json';
import { dirname, join } from 'path';
import type { CompilerOptions, System } from 'typescript';
import { resolvePrettierConfigPath } from '../../utils/prettier';
import { addSwcConfig } from '../../utils/swc/add-swc-config';
import { getSwcDependencies } from '../../utils/swc/add-swc-dependencies';
import { tsConfigBaseOptions } from '../../utils/typescript/create-ts-config';
import {
  addTsConfigPath,
  getRelativePathToRootTsConfig,
  getRootTsConfigFileName,
} from '../../utils/typescript/ts-config';
import { isWorkspaceSetupWithTsSolution } from '../../utils/typescript/ts-solution-setup';
import {
  esbuildVersion,
  nxVersion,
  swcHelpersVersion,
  tsLibVersion,
  typesNodeVersion,
} from '../../utils/versions';
import jsInitGenerator from '../init/init';
import setupVerdaccio from '../setup-verdaccio/generator';
import type {
  Bundler,
  LibraryGeneratorSchema,
  NormalizedLibraryGeneratorOptions,
} from './schema';
import { ensureTypescript } from '../../utils/typescript/ensure-typescript';

const defaultOutputDirectory = 'dist';
let ts: typeof import('typescript');

export async function libraryGenerator(
  tree: Tree,
  schema: LibraryGeneratorSchema
) {
  return await libraryGeneratorInternal(tree, {
    addPlugin: false,
    // provide a default projectNameAndRootFormat to avoid breaking changes
    // to external generators invoking this one
    projectNameAndRootFormat: 'derived',
    useProjectJson: true,
    linter: 'eslint',
    unitTestRunner: schema.bundler === 'vite' ? 'vitest' : 'jest',
    ...schema,
  });
}

export async function libraryGeneratorInternal(
  tree: Tree,
  schema: LibraryGeneratorSchema
) {
  const tasks: GeneratorCallback[] = [];

  const options = await normalizeOptions(tree, schema);

  tasks.push(
    await jsInitGenerator(tree, {
      ...options,
      skipFormat: true,
      tsConfigName: options.rootProject
        ? 'tsconfig.json'
        : 'tsconfig.base.json',
      addTsConfigBase: true,
    })
  );

  createFiles(tree, options);

  await configureProject(tree, options);

  if (!options.skipPackageJson) {
    tasks.push(addProjectDependencies(tree, options));
  }

  if (options.publishable) {
    tasks.push(await setupVerdaccio(tree, { ...options, skipFormat: true }));
  }

  if (options.bundler === 'rollup') {
    const { configurationGenerator } = ensurePackage('@nx/rollup', nxVersion);
    await configurationGenerator(tree, {
      project: options.name,
      compiler: 'swc',
      format: ['cjs', 'esm'],
    });
  }

  if (options.bundler === 'vite') {
    const { viteConfigurationGenerator, createOrEditViteConfig } =
      ensurePackage('@nx/vite', nxVersion);
    const viteTask = await viteConfigurationGenerator(tree, {
      project: options.name,
      newProject: true,
      uiFramework: 'none',
      includeVitest: options.unitTestRunner === 'vitest',
      includeLib: true,
      skipFormat: true,
      testEnvironment: options.testEnvironment,
      addPlugin: options.addPlugin,
      setUpPrettier: options.setUpPrettier,
    });
    tasks.push(viteTask);
    createOrEditViteConfig(
      tree,
      {
        project: options.name,
        includeLib: true,
        includeVitest: options.unitTestRunner === 'vitest',
        testEnvironment: options.testEnvironment,
      },
      false
    );
  }
  if (options.linter !== 'none') {
    const lintCallback = await addLint(tree, options);
    tasks.push(lintCallback);
  }

  if (options.unitTestRunner === 'jest') {
    const jestCallback = await addJest(tree, options);
    tasks.push(jestCallback);
    if (options.bundler === 'swc' || options.bundler === 'rollup') {
      replaceJestConfig(tree, options);
    }
  } else if (
    options.unitTestRunner === 'vitest' &&
    options.bundler !== 'vite' // Test would have been set up already
  ) {
    const { vitestGenerator, createOrEditViteConfig } = ensurePackage(
      '@nx/vite',
      nxVersion
    );
    const vitestTask = await vitestGenerator(tree, {
      project: options.name,
      uiFramework: 'none',
      coverageProvider: 'v8',
      skipFormat: true,
      testEnvironment: options.testEnvironment,
      setUpPrettier: options.setUpPrettier,
    });
    tasks.push(vitestTask);
    createOrEditViteConfig(
      tree,
      {
        project: options.name,
        includeLib: false,
        includeVitest: true,
        testEnvironment: options.testEnvironment,
      },
      true
    );
  }

  if (!schema.skipTsConfig && options.useProjectJson) {
    addTsConfigPath(tree, options.importPath, [
      joinPathFragments(
        options.projectRoot,
        './src',
        'index.' + (options.js ? 'js' : 'ts')
      ),
    ]);
  }

  if (options.isUsingTsSolutionConfig && options.unitTestRunner !== 'none') {
    // TODO(leo): move this to the specific test generators
    updateJson(
      tree,
      joinPathFragments(options.projectRoot, 'tsconfig.spec.json'),
      (json) => {
        const rootOffset = offsetFromRoot(options.projectRoot);
        // ensure it extends from the root tsconfig.base.json
        json.extends = joinPathFragments(rootOffset, 'tsconfig.base.json');
        // ensure outDir is set to the correct value
        json.compilerOptions ??= {};
        json.compilerOptions.outDir = joinPathFragments(
          rootOffset,
          'dist/out-tsc',
          options.projectRoot
        );
        // add project reference to the runtime tsconfig.lib.json file
        json.references ??= [];
        json.references.push({ path: './tsconfig.lib.json' });
        return json;
      }
    );
  }

  if (options.bundler !== 'none') {
    addBundlerDependencies(tree, options);
  }

  if (!options.skipFormat) {
    await formatFiles(tree);
  }

  if (options.publishable) {
    tasks.push(() => {
      logNxReleaseDocsInfo();
    });
  }

  tasks.push(() => {
    logShowProjectCommand(options.name);
  });

  return runTasksInSerial(...tasks);
}

async function configureProject(
  tree: Tree,
  options: NormalizedLibraryGeneratorOptions
) {
  if (!options.useProjectJson) {
    if (options.name !== options.importPath) {
      // if the name is different than the package.json name, we need to set
      // the proper name in the configuration
      updateProjectConfiguration(tree, options.name, {
        name: options.name,
        root: options.projectRoot,
      });
    }

    // update the `@nx/js/typescript` plugin config as needed, it was already
    // added by the init generator
    // const nxJson = readNxJson(tree);
    // const tsPluginRegistrations = nxJson.plugins?.filter(
    //   (plugin): plugin is ExpandedPluginConfiguration =>
    //     (typeof plugin === 'string' && plugin === '@nx/js/typescript') ||
    //     (typeof plugin !== 'string' && plugin.plugin === '@nx/jest/plugin')
    // );

    return;
  }

  const projectConfiguration: ProjectConfiguration = {
    root: options.projectRoot,
    sourceRoot: joinPathFragments(options.projectRoot, 'src'),
    projectType: 'library',
    targets: {},
    tags: options.parsedTags,
  };

  if (
    options.bundler &&
    options.bundler !== 'none' &&
    options.config !== 'npm-scripts'
  ) {
    if (options.bundler !== 'rollup') {
      const outputPath = getOutputPath(options);
      const executor = getBuildExecutor(options.bundler);
      addBuildTargetDefaults(tree, executor);

      projectConfiguration.targets.build = {
        executor,
        outputs: ['{options.outputPath}'],
        options: {
          outputPath,
          main:
            `${options.projectRoot}/src/index` + (options.js ? '.js' : '.ts'),
          tsConfig: `${options.projectRoot}/tsconfig.lib.json`,
          assets: [],
        },
      };

      if (options.bundler === 'esbuild') {
        projectConfiguration.targets.build.options.generatePackageJson = true;
        projectConfiguration.targets.build.options.format = ['cjs'];
      }

      if (options.bundler === 'swc' && options.skipTypeCheck) {
        projectConfiguration.targets.build.options.skipTypeCheck = true;
      }

      if (!options.minimal) {
        projectConfiguration.targets.build.options.assets ??= [];
        projectConfiguration.targets.build.options.assets.push(
          joinPathFragments(options.projectRoot, '*.md')
        );
      }
    }

    if (options.publishable) {
      const packageRoot = joinPathFragments(
        defaultOutputDirectory,
        '{projectRoot}'
      );

      projectConfiguration.targets ??= {};
      projectConfiguration.targets['nx-release-publish'] = {
        options: {
          packageRoot,
        },
      };

      projectConfiguration.release = {
        version: {
          generatorOptions: {
            packageRoot,
            // using git tags to determine the current version is required here because
            // the version in the package root is overridden with every build
            currentVersionResolver: 'git-tag',
          },
        },
      };

      await addProjectToNxReleaseConfig(tree, options, projectConfiguration);
    }
  }

  if (options.config === 'workspace' || options.config === 'project') {
    addProjectConfiguration(tree, options.name, projectConfiguration);
  } else {
    addProjectConfiguration(tree, options.name, {
      root: projectConfiguration.root,
      tags: projectConfiguration.tags,
      targets: {},
    });
  }
}

export type AddLintOptions = Pick<
  NormalizedLibraryGeneratorOptions,
  | 'name'
  | 'linter'
  | 'projectRoot'
  | 'unitTestRunner'
  | 'js'
  | 'setParserOptionsProject'
  | 'rootProject'
  | 'bundler'
  | 'addPlugin'
>;

export async function addLint(
  tree: Tree,
  options: AddLintOptions
): Promise<GeneratorCallback> {
  const { lintProjectGenerator } = ensurePackage('@nx/eslint', nxVersion);
  const projectConfiguration = readProjectConfiguration(tree, options.name);
  const task = await lintProjectGenerator(tree, {
    project: options.name,
    linter: options.linter,
    skipFormat: true,
    tsConfigPaths: [
      joinPathFragments(options.projectRoot, 'tsconfig.lib.json'),
    ],
    unitTestRunner: options.unitTestRunner,
    setParserOptionsProject: options.setParserOptionsProject,
    rootProject: options.rootProject,
    addPlugin: options.addPlugin,
    // Since the build target is inferred now, we need to let the generator know to add @nx/dependency-checks regardless.
    addPackageJsonDependencyChecks: options.bundler !== 'none',
  });
  const {
    addOverrideToLintConfig,
    lintConfigHasOverride,
    isEslintConfigSupported,
    updateOverrideInLintConfig,
    // nx-ignore-next-line
  } = require('@nx/eslint/src/generators/utils/eslint-file');

  // if config is not supported, we don't need to do anything
  if (!isEslintConfigSupported(tree)) {
    return task;
  }

  // Also update the root ESLint config. The lintProjectGenerator will not generate it for root projects.
  // But we need to set the package.json checks.
  if (options.rootProject) {
    addOverrideToLintConfig(tree, '', {
      files: ['*.json'],
      parser: 'jsonc-eslint-parser',
      rules: {
        '@nx/dependency-checks': [
          'error',
          {
            // With flat configs, we don't want to include imports in the eslint js/cjs/mjs files to be checked
            ignoredFiles: ['{projectRoot}/eslint.config.{js,cjs,mjs}'],
          },
        ],
      },
    });
  }

  // If project lints package.json with @nx/dependency-checks, then add ignore files for
  // build configuration files such as vite.config.ts. These config files need to be
  // ignored, otherwise we will errors on missing dependencies that are for dev only.
  if (
    lintConfigHasOverride(
      tree,
      projectConfiguration.root,
      (o) =>
        Array.isArray(o.files)
          ? o.files.some((f) => f.match(/\.json$/))
          : !!o.files?.match(/\.json$/),
      true
    )
  ) {
    updateOverrideInLintConfig(
      tree,
      projectConfiguration.root,
      (o) => o.rules?.['@nx/dependency-checks'],
      (o) => {
        const value = o.rules['@nx/dependency-checks'];
        let ruleSeverity: string;
        let ruleOptions: any;
        if (Array.isArray(value)) {
          ruleSeverity = value[0];
          ruleOptions = value[1];
        } else {
          ruleSeverity = value;
          ruleOptions = {};
        }
        if (options.bundler === 'vite' || options.unitTestRunner === 'vitest') {
          ruleOptions.ignoredFiles ??= [];
          ruleOptions.ignoredFiles.push(
            '{projectRoot}/vite.config.{js,ts,mjs,mts}'
          );
          o.rules['@nx/dependency-checks'] = [ruleSeverity, ruleOptions];
        } else if (options.bundler === 'rollup') {
          ruleOptions.ignoredFiles ??= [];
          ruleOptions.ignoredFiles.push(
            '{projectRoot}/rollup.config.{js,ts,mjs,mts}'
          );
          o.rules['@nx/dependency-checks'] = [ruleSeverity, ruleOptions];
        } else if (options.bundler === 'esbuild') {
          ruleOptions.ignoredFiles ??= [];
          ruleOptions.ignoredFiles.push(
            '{projectRoot}/esbuild.config.{js,ts,mjs,mts}'
          );
          o.rules['@nx/dependency-checks'] = [ruleSeverity, ruleOptions];
        }
        return o;
      }
    );
  }
  return task;
}

function addBundlerDependencies(
  tree: Tree,
  options: NormalizedLibraryGeneratorOptions
) {
  updateJson(tree, `${options.projectRoot}/package.json`, (json) => {
    if (options.bundler === 'tsc') {
      json.dependencies = {
        ...json.dependencies,
        tslib: tsLibVersion,
      };
    } else if (options.bundler === 'swc') {
      json.dependencies = {
        ...json.dependencies,
        '@swc/helpers': swcHelpersVersion,
      };
    }
    return json;
  });
}

function addBabelRc(tree: Tree, options: NormalizedLibraryGeneratorOptions) {
  const filename = '.babelrc';

  const babelrc = {
    presets: [['@nx/js/babel', { useBuiltIns: 'usage' }]],
  };

  writeJson(tree, join(options.projectRoot, filename), babelrc);
}

function createFiles(tree: Tree, options: NormalizedLibraryGeneratorOptions) {
  const { className, name, propertyName } = names(
    options.projectNames.projectFileName
  );

  createProjectTsConfigs(tree, options);

  generateFiles(tree, join(__dirname, './files/lib'), options.projectRoot, {
    ...options,
    dot: '.',
    className,
    name,
    propertyName,
    js: !!options.js,
    cliCommand: 'nx',
    strict: undefined,
    tmpl: '',
    offsetFromRoot: offsetFromRoot(options.projectRoot),
    buildable: options.bundler && options.bundler !== 'none',
    hasUnitTestRunner: options.unitTestRunner !== 'none',
  });

  if (!options.rootProject) {
    generateFiles(
      tree,
      join(__dirname, './files/readme'),
      options.projectRoot,
      {
        ...options,
        dot: '.',
        className,
        name,
        propertyName,
        js: !!options.js,
        cliCommand: 'nx',
        strict: undefined,
        tmpl: '',
        offsetFromRoot: offsetFromRoot(options.projectRoot),
        buildable: options.bundler && options.bundler !== 'none',
        hasUnitTestRunner: options.unitTestRunner !== 'none',
      }
    );
  }

  if (options.bundler === 'swc' || options.bundler === 'rollup') {
    addSwcConfig(
      tree,
      options.projectRoot,
      options.bundler === 'swc' ? 'commonjs' : 'es6'
    );
  } else if (options.includeBabelRc) {
    addBabelRc(tree, options);
  }

  if (options.unitTestRunner === 'none') {
    tree.delete(
      join(options.projectRoot, 'src/lib', `${options.fileName}.spec.ts`)
    );
    tree.delete(
      join(options.projectRoot, 'src/app', `${options.fileName}.spec.ts`)
    );
  }

  if (options.js) {
    toJS(tree);
  }

  const packageJsonPath = joinPathFragments(
    options.projectRoot,
    'package.json'
  );
  if (tree.exists(packageJsonPath)) {
    updateJson<PackageJson>(tree, packageJsonPath, (json) => {
      json.name = options.importPath;
      json.version = '0.0.1';
      // If the package is publishable or root/standalone, we should remove the private field.
      if (json.private && (options.publishable || options.rootProject)) {
        delete json.private;
      }
      if (!options.publishable && !options.rootProject) {
        json.private = true;
      }
      return {
        ...json,
        dependencies: {
          ...json.dependencies,
          ...determineDependencies(options),
        },
        ...determineEntryFields(options),
      };
    });
  } else {
    const packageJson: PackageJson = {
      name: options.importPath,
      version: '0.0.1',
      dependencies: determineDependencies(options),
      ...determineEntryFields(options),
    };
    if (!options.publishable && !options.rootProject) {
      packageJson.private = true;
    }
    writeJson<PackageJson>(tree, packageJsonPath, packageJson);
  }

  if (options.config === 'npm-scripts') {
    updateJson(tree, packageJsonPath, (json) => {
      json.scripts = {
        build: "echo 'implement build'",
        test: "echo 'implement test'",
      };
      return json;
    });
  } else if (
    (!options.bundler || options.bundler === 'none') &&
    options.projectRoot !== '.' &&
    options.useProjectJson
  ) {
    tree.delete(packageJsonPath);
  }

  if (options.minimal && !(options.projectRoot === '.')) {
    tree.delete(join(options.projectRoot, 'README.md'));
  }
}

async function addJest(
  tree: Tree,
  options: NormalizedLibraryGeneratorOptions
): Promise<GeneratorCallback> {
  const { configurationGenerator } = ensurePackage('@nx/jest', nxVersion);
  return await configurationGenerator(tree, {
    ...options,
    project: options.name,
    setupFile: 'none',
    supportTsx: false,
    skipSerializers: true,
    testEnvironment: options.testEnvironment,
    skipFormat: true,
    compiler:
      options.bundler === 'swc' || options.bundler === 'tsc'
        ? options.bundler
        : options.bundler === 'rollup'
        ? 'swc'
        : undefined,
  });
}

function replaceJestConfig(
  tree: Tree,
  options: NormalizedLibraryGeneratorOptions
) {
  const filesDir = join(__dirname, './files/jest-config');
  // the existing config has to be deleted otherwise the new config won't overwrite it
  const existingJestConfig = joinPathFragments(
    filesDir,
    `jest.config.${options.js ? 'js' : 'ts'}`
  );
  if (tree.exists(existingJestConfig)) {
    tree.delete(existingJestConfig);
  }
  const jestPreset = findRootJestPreset(tree) ?? 'jest.presets.js';

  // replace with JS:SWC specific jest config
  generateFiles(tree, filesDir, options.projectRoot, {
    ext: options.js ? 'js' : 'ts',
    jestPreset,
    js: !!options.js,
    project: options.name,
    offsetFromRoot: offsetFromRoot(options.projectRoot),
    projectRoot: options.projectRoot,
    testEnvironment: options.testEnvironment,
  });
}

function isNonInteractive(): boolean {
  return (
    isCI() || !process.stdout.isTTY || process.env.NX_INTERACTIVE !== 'true'
  );
}

async function promptWhenInteractive<T>(
  questions: Parameters<typeof prompt>[0],
  defaultValue: T
): Promise<T> {
  if (isNonInteractive()) {
    return defaultValue;
  }

  return await prompt(questions);
}

async function normalizeOptions(
  tree: Tree,
  options: LibraryGeneratorSchema
): Promise<NormalizedLibraryGeneratorOptions> {
  const nxJson = readNxJson(tree);

  options.addPlugin ??=
    process.env.NX_ADD_PLUGINS !== 'false' &&
    nxJson.useInferencePlugins !== false;
  const addTsPlugin =
    options.addPlugin && process.env.NX_ADD_TS_PLUGIN === 'true';
  const hasPlugin =
    addTsPlugin ||
    nxJson.plugins?.some((p) =>
      typeof p === 'string'
        ? p === '@nx/js/typescript'
        : p.plugin === '@nx/js/typescript'
    );

  if (hasPlugin) {
    if (options.bundler === 'esbuild' || options.bundler === 'swc') {
      throw new Error(
        `Cannot use the "${options.bundler}" bundler when using the @nx/js/typescript plugin.`
      );
    }

    if (options.bundler === undefined && options.compiler === undefined) {
      options.bundler = await promptWhenInteractive<{ bundler: Bundler }>(
        {
          type: 'select',
          name: 'bundler',
          message: `Which bundler would you like to use to build the library? Choose 'none' to skip build setup.`,
          choices: [
            { name: 'tsc' },
            { name: 'rollup' },
            { name: 'vite' },
            { name: 'none' },
          ],
          initial: 0,
        },
        { bundler: 'tsc' }
      ).then(({ bundler }) => bundler);
    }

    if (
      options.setUpPrettier === undefined &&
      !(await resolvePrettierConfigPath(tree))
    ) {
      options.setUpPrettier = await promptWhenInteractive<{
        setUpPrettier: boolean;
      }>(
        {
          type: 'confirm',
          name: 'setUpPrettier',
          message: 'Would you like to set up prettier in the workspace?',
          initial: false,
        },
        { setUpPrettier: false }
      ).then(({ setUpPrettier }) => setUpPrettier);
    }
  } else if (options.bundler === undefined && options.compiler === undefined) {
    options.bundler = await promptWhenInteractive<{ bundler: Bundler }>(
      {
        type: 'select',
        name: 'bundler',
        message: `Which bundler would you like to use to build the library? Choose 'none' to skip build setup.`,
        choices: [
          { name: 'swc' },
          { name: 'tsc' },
          { name: 'rollup' },
          { name: 'vite' },
          { name: 'esbuild' },
          { name: 'none' },
        ],
        initial: 1,
      },
      { bundler: 'tsc' }
    ).then(({ bundler }) => bundler);
  } else {
    /**
     * We are deprecating the compiler and the buildable options.
     * However, we want to keep the existing behavior for now.
     *
     * So, if the user has not provided a bundler, we will use the compiler option, if any.
     *
     * If the user has not provided a bundler and no compiler, but has set buildable to true,
     * we will use tsc, since that is the compiler the old generator used to default to, if buildable was true
     * and no compiler was provided.
     *
     * If the user has not provided a bundler and no compiler, and has not set buildable to true, then
     * set the bundler to tsc, to preserve old default behaviour (buildable: true by default).
     *
     * If it's publishable, we need to build the code before publishing it, so again
     * we default to `tsc`. In the previous version of this, it would set `buildable` to true
     * and that would default to `tsc`.
     *
     * In the past, the only way to get a non-buildable library was to set buildable to false.
     * Now, the only way to get a non-buildble library is to set bundler to none.
     * By default, with nothing provided, libraries are buildable with `@nx/js:tsc`.
     */

    options.bundler ??= options.compiler;
  }

  options.linter ??= 'none';
  options.unitTestRunner ??= 'none';

  // ensure programmatic runs have an expected default
  if (!options.config) {
    options.config = 'project';
  }

  if (options.publishable) {
    if (!options.importPath) {
      throw new Error(
        `For publishable libs you have to provide a proper "--importPath" which needs to be a valid npm package name (e.g. my-awesome-lib or @myorg/my-lib)`
      );
    }

    if (options.bundler === 'none') {
      options.bundler = 'tsc';
    }
  }

  // This is to preserve old behavior, buildable: false
  if (options.publishable === false && options.buildable === false) {
    options.bundler = 'none';
  }

  if (options.config === 'npm-scripts') {
    options.unitTestRunner = 'none';
    options.linter = 'none';
    options.bundler = 'none';
  }

  if (
    (options.bundler === 'swc' || options.bundler === 'rollup') &&
    options.skipTypeCheck == null
  ) {
    options.skipTypeCheck = false;
  }

  const {
    projectName,
    names: projectNames,
    projectRoot,
    importPath,
  } = await determineProjectNameAndRootOptions(tree, {
    name: options.name,
    projectType: 'library',
    directory: options.directory,
    importPath: options.importPath,
    projectNameAndRootFormat: options.projectNameAndRootFormat,
    rootProject: options.rootProject,
    callingGenerator: '@nx/js:library',
  });
  options.rootProject = projectRoot === '.';
  const fileName = getCaseAwareFileName({
    fileName: options.simpleName
      ? projectNames.projectSimpleName
      : projectNames.projectFileName,
    pascalCaseFiles: options.pascalCaseFiles,
  });

  const parsedTags = options.tags
    ? options.tags.split(',').map((s) => s.trim())
    : [];

  options.minimal ??= false;

  // We generate a project.json file if the user has opted out of the TS plugin
  // or if the project is not in the package manager workspaces' configuration.
  // TODO(leo): log a warning if the user explicitly sets useProjectJson to true
  // and the project is not in the workspaces config. Also, consider automatically
  // adding the project to the workspaces config if it's not there.
  options.useProjectJson ??= hasPlugin
    ? !isProjectInPackageManagerWorkspaces(tree, projectRoot)
    : true;

  // If there is no root tsconfig file and we're meant to add the TS plugin,
  // we'll generate a TS solution config. Otherwise, we check if the workspace
  // is already setup with a TS solution config.
  const isUsingTsSolutionConfig =
    (!getRootTsConfigFileName(tree) && addTsPlugin) ||
    isWorkspaceSetupWithTsSolution(tree);

  return {
    ...options,
    fileName,
    name: projectName,
    projectNames,
    projectRoot,
    parsedTags,
    importPath,
    hasPlugin,
    isUsingTsSolutionConfig,
  };
}

function isProjectInPackageManagerWorkspaces(
  tree: Tree,
  projectRoot: string
): boolean {
  if (!isWorkspacesEnabled(detectPackageManager(tree.root), tree.root)) {
    return false;
  }

  const patterns = getGlobPatternsFromPackageManagerWorkspaces(
    tree.root,
    (path) => readJson(tree, path, { expectComments: true })
  );

  return patterns.some((p) =>
    minimatch(joinPathFragments(projectRoot, 'package.json'), p)
  );
}

function getCaseAwareFileName(options: {
  pascalCaseFiles: boolean;
  fileName: string;
}) {
  const normalized = names(options.fileName);

  return options.pascalCaseFiles ? normalized.className : normalized.fileName;
}

function addProjectDependencies(
  tree: Tree,
  options: NormalizedLibraryGeneratorOptions
): GeneratorCallback {
  if (options.bundler == 'esbuild') {
    return addDependenciesToPackageJson(
      tree,
      {},
      {
        '@nx/esbuild': nxVersion,
        '@types/node': typesNodeVersion,
        esbuild: esbuildVersion,
      }
    );
  } else if (options.bundler == 'rollup') {
    const { dependencies, devDependencies } = getSwcDependencies();
    return addDependenciesToPackageJson(
      tree,
      { ...dependencies },
      {
        ...devDependencies,
        '@nx/rollup': nxVersion,
        '@types/node': typesNodeVersion,
      }
    );
  } else if (options.bundler === 'tsc') {
    return addDependenciesToPackageJson(
      tree,
      {},
      { tslib: tsLibVersion, '@types/node': typesNodeVersion }
    );
  } else if (options.bundler === 'swc') {
    const { dependencies, devDependencies } = getSwcDependencies();
    return addDependenciesToPackageJson(
      tree,
      { ...dependencies },
      { ...devDependencies, '@types/node': typesNodeVersion }
    );
  } else {
    return addDependenciesToPackageJson(
      tree,
      {},
      { '@types/node': typesNodeVersion }
    );
  }

  // Vite is being installed in the next step if bundler is vite
  // noop
  return () => {};
}

function getBuildExecutor(bundler: Bundler) {
  switch (bundler) {
    case 'esbuild':
      return `@nx/esbuild:esbuild`;
    case 'rollup':
      return `@nx/rollup:rollup`;
    case 'swc':
    case 'tsc':
      return `@nx/js:${bundler}`;
    case 'vite':
      return `@nx/vite:build`;
    case 'none':
    default:
      return undefined;
  }
}

function getOutputPath(options: NormalizedLibraryGeneratorOptions) {
  const parts = [defaultOutputDirectory];
  if (options.projectRoot === '.') {
    parts.push(options.name);
  } else {
    parts.push(options.projectRoot);
  }
  return joinPathFragments(...parts);
}

type CompilerOptionsEnumProps = Pick<
  CompilerOptions,
  | 'importsNotUsedAsValues'
  | 'jsx'
  | 'module'
  | 'moduleDetection'
  | 'moduleResolution'
  | 'newLine'
  | 'target'
>;
const optionEnumTypeMap: {
  [key in keyof CompilerOptionsEnumProps]: keyof typeof ts;
} = {
  importsNotUsedAsValues: 'ImportsNotUsedAsValues',
  jsx: 'JsxEmit',
  module: 'ModuleKind',
  moduleDetection: 'ModuleDetectionKind',
  moduleResolution: 'ModuleResolutionKind',
  newLine: 'NewLineKind',
  target: 'ScriptTarget',
};
type Entries<T extends object> = { [K in keyof T]: [K, T[K]] }[keyof T];
function reverseEnum<
  EnumObj extends Record<keyof EnumObj, string>,
  Result = {
    [K in EnumObj[keyof EnumObj]]: Extract<Entries<EnumObj>, [any, K]>[0];
  }
>(enumObj: EnumObj): Result {
  return Object.keys(enumObj).reduce((acc, key) => {
    acc[enumObj[key]] = key;
    return acc;
  }, {} as Result);
}

// filters out the compiler options that are already set in the extended tsconfig
function getNeededCompilerOptionOverrides(
  tree: Tree,
  extendedTsConfigPath: string,
  compilerOptions: Record<keyof CompilerOptions, any>
): Record<keyof CompilerOptions, any> {
  if (!ts) {
    ts = ensureTypescript();
  }

  const tsSysFromTree: System = {
    ...ts.sys,
    readFile: (path) => tree.read(path, 'utf-8'),
  };

  const parsed = ts.parseJsonConfigFileContent(
    ts.readConfigFile(extendedTsConfigPath, tsSysFromTree.readFile).config,
    tsSysFromTree,
    dirname(extendedTsConfigPath)
  );

  // ModuleKind: { CommonJS: 'commonjs', ... } => ModuleKind: { commonjs: 'CommonJS', ... }
  const reversedCompilerOptionsEnumValues = {
    JsxEmit: reverseEnum(ts.server.protocol.JsxEmit),
    ModuleKind: reverseEnum(ts.server.protocol.ModuleKind),
    ModuleResolutionKind: reverseEnum(ts.server.protocol.ModuleResolutionKind),
    NewLineKind: reverseEnum(ts.server.protocol.NewLineKind),
    ScriptTarget: reverseEnum(ts.server.protocol.ScriptTarget),
  };
  const matchesValue = (key: keyof CompilerOptions) => {
    return (
      parsed.options[key] ===
        ts[optionEnumTypeMap[key]][compilerOptions[key]] ||
      parsed.options[key] ===
        ts[optionEnumTypeMap[key]][
          reversedCompilerOptionsEnumValues[optionEnumTypeMap[key]][
            compilerOptions[key]
          ]
        ]
    );
  };

  let result = {};
  for (const key of Object.keys(compilerOptions)) {
    if (optionEnumTypeMap[key]) {
      if (parsed.options[key] === undefined) {
        result[key] = compilerOptions[key];
      } else if (!matchesValue(key)) {
        result[key] = compilerOptions[key];
      }
    } else if (parsed.options[key] !== compilerOptions[key]) {
      result[key] = compilerOptions[key];
    }
  }

  return result;
}

function createProjectTsConfigs(
  tree: Tree,
  options: NormalizedLibraryGeneratorOptions
) {
  const rootOffset = offsetFromRoot(options.projectRoot);

  let compilerOptionOverrides: Record<keyof CompilerOptions, any> = {
    module: options.isUsingTsSolutionConfig
      ? options.bundler === 'rollup'
        ? 'esnext'
        : 'nodenext'
      : 'commonjs',
    ...(options.isUsingTsSolutionConfig
      ? options.bundler === 'rollup'
        ? { moduleResolution: 'bundler' }
        : { moduleResolution: 'nodenext' }
      : {}),
    ...(options.js ? { allowJs: true } : {}),
    ...(options.strict
      ? {
          forceConsistentCasingInFileNames: true,
          strict: true,
          noImplicitOverride: true,
          noImplicitReturns: true,
          noFallthroughCasesInSwitch: true,
          ...(!options.isUsingTsSolutionConfig
            ? { noPropertyAccessFromIndexSignature: true }
            : {}),
        }
      : {}),
  };

  if (!options.rootProject || options.isUsingTsSolutionConfig) {
    compilerOptionOverrides = getNeededCompilerOptionOverrides(
      tree,
      // must have been created by now
      getRootTsConfigFileName(tree)!,
      compilerOptionOverrides
    );
  }

  // tsconfig.lib.json
  generateFiles(
    tree,
    join(
      __dirname,
      'files/tsconfig-lib',
      options.isUsingTsSolutionConfig ? 'ts-solution' : 'non-ts-solution'
    ),
    options.projectRoot,
    {
      ...options,
      offsetFromRoot: rootOffset,
      js: !!options.js,
      compilerOptions: Object.entries(compilerOptionOverrides)
        .map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`)
        .join(',\n    '),
      tmpl: '',
    }
  );

  // tsconfig.json
  if (options.isUsingTsSolutionConfig) {
    if (options.rootProject) {
      // the root tsconfig.json is already created with the expected settings
      // for the TS plugin, we just need to update it with the project-specific
      // settings
      updateJson(tree, 'tsconfig.json', (json) => {
        json.references.push({
          path: './tsconfig.lib.json',
        });
        return json;
      });
    } else {
      // create a new tsconfig.json for the project
      const tsconfig = {
        extends: getRelativePathToRootTsConfig(tree, options.projectRoot),
        files: [],
        include: [],
        references: [{ path: './tsconfig.lib.json' }],
      };
      writeJson(
        tree,
        joinPathFragments(options.projectRoot, 'tsconfig.json'),
        tsconfig
      );

      // update root project tsconfig.json references with the new lib tsconfig
      updateJson(tree, 'tsconfig.json', (json) => {
        json.references ??= [];
        json.references.push({
          path: options.projectRoot.startsWith('./')
            ? options.projectRoot
            : './' + options.projectRoot,
        });
        return json;
      });
    }

    return;
  }

  const tsconfig = {
    extends: options.rootProject
      ? undefined
      : getRelativePathToRootTsConfig(tree, options.projectRoot),
    compilerOptions: {
      ...(options.rootProject ? tsConfigBaseOptions : {}),
      ...compilerOptionOverrides,
    },
    files: [],
    include: [],
    references: [
      {
        path: './tsconfig.lib.json',
      },
    ],
  };
  writeJson(
    tree,
    joinPathFragments(options.projectRoot, 'tsconfig.json'),
    tsconfig
  );
}

function determineDependencies(
  options: LibraryGeneratorSchema
): Record<string, string> {
  switch (options.bundler) {
    case 'tsc':
      // importHelpers is true by default, so need to add tslib as a dependency.
      return {
        tslib: tsLibVersion,
      };
    case 'swc':
      // externalHelpers is true  by default, so need to add swc helpers as a dependency.
      return {
        '@swc/helpers': swcHelpersVersion,
      };
    default: {
      // In other cases (vite, rollup, esbuild), helpers are bundled so no need to add them as a dependency.
      return {};
    }
  }
}

type EntryField = string | { [key: string]: EntryField };

function determineEntryFields(
  options: NormalizedLibraryGeneratorOptions
): Record<string, EntryField> {
  switch (options.bundler) {
    case 'tsc':
      return {
        type: 'commonjs',
        main: options.isUsingTsSolutionConfig
          ? './dist/index.js'
          : './src/index.js',
        typings: options.isUsingTsSolutionConfig
          ? './dist/index.d.ts'
          : './src/index.d.ts',
      };
    case 'swc':
      return {
        type: 'commonjs',
        main: './src/index.js',
        typings: './src/index.d.ts',
      };
    case 'rollup':
      return {
        // Since we're publishing both formats, skip the type field.
        // Bundlers or Node will determine the entry point to use.
        main: './index.cjs',
        module: './index.js',
      };
    case 'vite':
      return {
        // Since we're publishing both formats, skip the type field.
        // Bundlers or Node will determine the entry point to use.
        main: './index.js',
        module: './index.mjs',
        typings: './index.d.ts',
      };
    case 'esbuild':
      // For libraries intended for Node, use CJS.
      return {
        type: 'commonjs',
        main: './index.cjs',
        // typings is missing for esbuild currently
      };
    default: {
      return {
        // Safest option is to not set a type field.
        // Allow the user to decide which module format their library is using
        type: undefined,
      };
    }
  }
}

function projectsConfigMatchesProject(
  projectsConfig: string | string[] | undefined,
  project: ProjectGraphProjectNode
): boolean {
  if (!projectsConfig) {
    return false;
  }

  if (typeof projectsConfig === 'string') {
    projectsConfig = [projectsConfig];
  }

  const graph: Record<string, ProjectGraphProjectNode> = {
    [project.name]: project,
  };

  const matchingProjects = findMatchingProjects(projectsConfig, graph);

  return matchingProjects.includes(project.name);
}

async function addProjectToNxReleaseConfig(
  tree: Tree,
  options: NormalizedLibraryGeneratorOptions,
  projectConfiguration: ProjectConfiguration
) {
  const nxJson = readNxJson(tree);

  const addPreVersionCommand = () => {
    const pmc = getPackageManagerCommand();

    nxJson.release = {
      ...nxJson.release,
      version: {
        preVersionCommand: `${pmc.dlx} nx run-many -t build`,
        ...nxJson.release?.version,
      },
    };
  };

  if (!nxJson.release || (!nxJson.release.projects && !nxJson.release.groups)) {
    // skip adding any projects configuration since the new project should be
    // automatically included by nx release's default project detection logic
    addPreVersionCommand();
    writeJson(tree, 'nx.json', nxJson);
    return;
  }

  const project: ProjectGraphProjectNode = {
    name: options.name,
    type: 'lib' as const,
    data: {
      root: projectConfiguration.root,
      tags: projectConfiguration.tags,
    },
  };

  if (projectsConfigMatchesProject(nxJson.release.projects, project)) {
    output.log({
      title: `Project already included in existing release configuration`,
    });
    addPreVersionCommand();
    writeJson(tree, 'nx.json', nxJson);
    return;
  }

  if (Array.isArray(nxJson.release.projects)) {
    nxJson.release.projects.push(options.name);
    addPreVersionCommand();
    writeJson(tree, 'nx.json', nxJson);
    output.log({
      title: `Added project to existing release configuration`,
    });
  }

  if (nxJson.release.groups) {
    const allGroups = Object.entries(nxJson.release.groups);

    for (const [name, group] of allGroups) {
      if (projectsConfigMatchesProject(group.projects, project)) {
        addPreVersionCommand();
        writeJson(tree, 'nx.json', nxJson);
        return `Project already included in existing release configuration for group ${name}`;
      }
    }

    output.warn({
      title: `Could not find a release group that includes ${options.name}`,
      bodyLines: [
        `Ensure that ${options.name} is included in a release group's "projects" list in nx.json so it can be published with "nx release"`,
      ],
    });
    addPreVersionCommand();
    writeJson(tree, 'nx.json', nxJson);
    return;
  }

  if (typeof nxJson.release.projects === 'string') {
    nxJson.release.projects = [nxJson.release.projects, options.name];
    addPreVersionCommand();
    writeJson(tree, 'nx.json', nxJson);
    output.log({
      title: `Added project to existing release configuration`,
    });
    return;
  }
}

function logNxReleaseDocsInfo() {
  output.log({
    title: `📦 To learn how to publish this library, see https://nx.dev/core-features/manage-releases.`,
  });
}

function findRootJestPreset(tree: Tree): string | null {
  const ext = ['js', 'cjs', 'mjs'].find((ext) =>
    tree.exists(`jest.preset.${ext}`)
  );

  return ext ? `jest.preset.${ext}` : null;
}

export default libraryGenerator;
