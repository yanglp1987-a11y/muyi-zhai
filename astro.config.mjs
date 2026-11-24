// @ts-check
import { defineConfig } from 'astro/config';
import { unified } from '@astrojs/markdown-remark';
import rehypeSanitize from 'rehype-sanitize';

export default defineConfig({
  markdown: {
    processor: unified({
      rehypePlugins: [rehypeSanitize],
    }),
  },
});