import { createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router'
import LoginView from '../views/LoginView.vue'
import LobbyView from '../views/LobbyView.vue'
import RoomView from '../views/RoomView.vue'

const routes: RouteRecordRaw[] = [
  { path: '/', redirect: '/login' },
  {
    path: '/login',
    name: 'Login',
    component: LoginView
  },
  {
    path: '/lobby',
    name: 'Lobby',
    component: LobbyView
  },
  {
    path: '/room/:id',
    name: 'Room',
    component: RoomView
  }
]

const router = createRouter({
  history: createWebHashHistory(),
  routes
})

router.beforeEach(async (to, _from, next) => {
  if (to.path === '/login') {
    next()
    return
  }
  const token = localStorage.getItem('auth_token')
  if (!token) {
    next('/login')
    return
  }
  // 每次导航到受保护页面时校验 license 有效性
  try {
    const licenseInfo = await (window as any).api.licenseGetInfo()
    if (licenseInfo?.status === 'expired') {
      localStorage.removeItem('auth_token')
      next('/login')
      return
    }
  } catch {
    // license 检查失败不阻塞导航
  }
  next()
})

export default router
