import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

export interface VideoItem {
  id: string
  name: string
  path: string
  thumbnail: string
  duration: number
  width: number
  height: number
}

export const useAvatarSelectStore = defineStore('avatar-select', () => {
  const videoLibrary = ref<VideoItem[]>([])
  const playlist = ref<VideoItem[]>([])
  const currentVideoId = ref<string | null>(null)
  const sourceType = ref<'video' | 'camera' | 'video_stream'>('video')
  const selectedCameraId = ref<string | null>(null)
  const loading = ref(false)

  const currentVideo = computed(() => {
    return videoLibrary.value.find(v => v.id === currentVideoId.value) || null
  })

  function addToLibrary(video: VideoItem) {
    if (!videoLibrary.value.find(v => v.path === video.path)) {
      videoLibrary.value.push(video)
    }
  }

  function removeFromLibrary(id: string) {
    videoLibrary.value = videoLibrary.value.filter(v => v.id !== id)
    playlist.value = playlist.value.filter(v => v.id !== id)
    if (currentVideoId.value === id) {
      currentVideoId.value = null
    }
  }

  function addToPlaylist(video: VideoItem) {
    if (!playlist.value.find(v => v.id === video.id)) {
      playlist.value.push(video)
    }
  }

  function removeFromPlaylist(id: string) {
    playlist.value = playlist.value.filter(v => v.id !== id)
  }

  function selectVideo(id: string) {
    currentVideoId.value = id
  }

  function setSourceType(type: 'video' | 'camera' | 'video_stream') {
    sourceType.value = type
  }

  return {
    videoLibrary,
    playlist,
    currentVideoId,
    currentVideo,
    sourceType,
    selectedCameraId,
    loading,
    addToLibrary,
    removeFromLibrary,
    addToPlaylist,
    removeFromPlaylist,
    selectVideo,
    setSourceType
  }
})
