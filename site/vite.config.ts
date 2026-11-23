import { defineConfig } from 'vite';
import { releases } from './plugins/releases';
import { seo } from './plugins/seo';
import { REPO } from './src/releases';

export default defineConfig({
  // Relative asset paths, so the build works at a custom domain's root and under
  // the github.io project path alike.
  base: './',
  plugins: [releases({ repo: REPO }), seo({ repo: REPO })],
  build: {
    target: 'es2022',
  },
});
