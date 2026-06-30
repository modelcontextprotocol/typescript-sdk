import type { Theme } from 'vitepress';
import DefaultTheme from 'vitepress/theme';
import { h } from 'vue';

import Banner from './Banner.vue';
// Shared with the v2 site — do not duplicate.
import '../../../.vitepress/theme/custom.css';

export default {
    extends: DefaultTheme,
    Layout() {
        return h(DefaultTheme.Layout, null, {
            'layout-top': () => h(Banner)
        });
    }
} satisfies Theme;
