import type { ForgeConfig } from '@electron-forge/cli';
import path from 'node:path';

const config: ForgeConfig = {
  rebuildConfig: {
    onlyModules: [],
  },
  packagerConfig: {
    name: 'Synax',
    appBundleId: 'com.Synax.desktop',
    icon: path.resolve(__dirname, 'electron/resources/icon'),
    asar: true,
    extraResource: [
      './server-dist',
      './web/dist',
      './api/db/migrations',
    ],
    ignore: (file: string) => {
      if (!file) return false;
      if (file === '/package.json') return false;
      if (file.startsWith('/dist-electron')) return false;
      return true;
    },
  },
  makers: [
    {
      name: '@electron-forge/maker-dmg',
      config: {
        format: 'ULFO',
      },
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin', 'linux', 'win32'],
    },
    {
      name: '@electron-forge/maker-squirrel',
      config: {
        name: 'Synax',
      },
    },
  ],
};

export default config;
