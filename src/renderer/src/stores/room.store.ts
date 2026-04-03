import { defineStore } from 'pinia'
import { ref } from 'vue'

export interface Room {
  id: string
  name: string
  platform: string
  status: string
  profile_id: string | null
  profile_name: string | null
  created_at: string
}

export const useRoomStore = defineStore('room', () => {
  const rooms = ref<Room[]>([])
  const loading = ref(false)

  async function fetchRooms(): Promise<void> {
    loading.value = true
    try {
      rooms.value = (await window.api.roomList()) || []
    } finally {
      loading.value = false
    }
  }

  async function createRoom(data: { name: string; platform: string; profileId?: string }): Promise<Room> {
    const room = await window.api.roomCreate(data)
    await fetchRooms()
    return room
  }

  async function updateRoom(id: string, data: any): Promise<void> {
    await window.api.roomUpdate(id, data)
    await fetchRooms()
  }

  async function deleteRoom(id: string): Promise<{ ok: boolean; error?: string }> {
    const result = await window.api.roomDelete(id)
    if (result?.ok !== false) await fetchRooms()
    return result
  }

  async function copyRoom(id: string, newName: string): Promise<void> {
    await window.api.roomCopy(id, newName)
    await fetchRooms()
  }

  return { rooms, loading, fetchRooms, createRoom, updateRoom, deleteRoom, copyRoom }
})
