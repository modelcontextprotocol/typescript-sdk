<script setup lang="ts">
import { useData, withBase } from 'vitepress';
import { computed } from 'vue';

// Every guide page has a markdown rendition generated next to its HTML (see
// ../llms.ts); the generated API reference does not.
const { page } = useData();
const mdPath = computed(() => (page.value.relativePath.startsWith('api/') ? undefined : withBase(`/${page.value.relativePath}`)));
</script>

<template>
    <div v-if="mdPath" class="markdown-source">
        Are you an LLM (or feeding one)? This page as
        <a :href="mdPath" target="_self">markdown</a> · <a :href="withBase('/llms.txt')" target="_self">llms.txt</a> ·
        <a :href="withBase('/llms-full.txt')" target="_self">llms-full.txt</a>
    </div>
</template>
