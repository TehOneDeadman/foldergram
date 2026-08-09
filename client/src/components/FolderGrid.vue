<template>
  <section class="grid gap-[1px]" :class="columns === 'three' ? 'grid-cols-3' : 'grid-cols-3 md:grid-cols-4'">
    <RouterLink v-for="item in items" :key="item.id" custom :to="buildImageRoute(item.id)" v-slot="{ href, navigate }">
      <a
        :href="href"
        class="group relative overflow-hidden bg-surface-alt"
        :class="variant === 'reels' ? 'aspect-[9/14]' : variant === 'posts' ? 'aspect-[3/4]' : 'aspect-square'"
        @click="handleImageNavigation($event, navigate)"
      >
        <ResilientImage
          :src="item.thumbnailUrl"
          :alt="item.filename"
          loading="lazy"
          :retry-while="appStore.isScanning"
          class="h-full w-full object-cover group-hover:scale-[1.03] group-hover:opacity-90"
          style="transition: transform 0.22s ease, opacity 0.22s ease;"
        />
        <div v-if="item.mediaType === 'video'" class="absolute inset-x-0 top-0 flex items-center justify-between px-2 py-2 text-white pointer-events-none bg-[linear-gradient(180deg,rgba(10,14,24,0.72)_0%,rgba(10,14,24,0)_100%)]">
          <span class="i-fluent-play-circle-24-filled w-[1.15rem] h-[1.15rem] text-white" aria-hidden="true" />
          <span v-if="item.durationMs" class="rounded-full bg-black/55 px-[0.42rem] py-[0.12rem] text-[0.7rem] font-semibold">
            {{ formatMediaDuration(item.durationMs) }}
          </span>
        </div>
      </a>
    </RouterLink>
  </section>
</template>

<script setup lang="ts">
import { RouterLink, useRoute } from 'vue-router';

import { useAppStore } from '../stores/app';
import type { FeedItem, SharedFeedItem } from '../types/api';
import { formatMediaDuration } from '../utils/media';
import ResilientImage from './ResilientImage.vue';

const props = withDefaults(
  defineProps<{
    items: Array<FeedItem | SharedFeedItem>;
    variant?: 'square' | 'posts' | 'reels';
    columns?: 'adaptive' | 'three';
    sharedSlug?: string | null;
  }>(),
  {
    variant: 'square',
    columns: 'adaptive',
    sharedSlug: null
  }
);

const appStore = useAppStore();
const route = useRoute();

function buildImageRoute(id: number) {
  if (props.sharedSlug) {
    return {
      name: 'shared-image',
      params: {
        slug: props.sharedSlug,
        id: String(id)
      },
      query: route.query
    };
  }

  return {
    name: 'image',
    params: { id: String(id) },
    query: route.query
  };
}

function handleImageNavigation(event: MouseEvent, navigate: () => void) {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return;
  }

  event.preventDefault();
  if (props.sharedSlug) {
    navigate();
    return;
  }

  appStore.setImageModalBackground(route.fullPath);
  navigate();
}
</script>
