import type { Theme } from 'vitepress';
import DefaultTheme from 'vitepress/theme';
import { h } from 'vue';

import Banner from './Banner.vue';
import './custom.css';

export default {
    extends: DefaultTheme,
    Layout() {
        return h(DefaultTheme.Layout, null, {
            'layout-top': () => h(Banner)
        });
    }
} satisfies Theme;
