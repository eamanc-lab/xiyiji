import { exec, ChildProcess, execSync } from 'child_process'
import { EventEmitter } from 'events'

class VirtualCameraService extends EventEmitter {
  private process: ChildProcess | null = null
  private running = false

  /**
   * Check if OBS Virtual Camera is installed on the system.
   */
  isOBSVirtualCameraInstalled(): boolean {
    try {
      // Check for OBS Virtual Camera in DirectShow devices via FFmpeg
      const output = execSync('ffmpeg -list_devices true -f dshow -i dummy 2>&1', {
        timeout: 5000,
        encoding: 'utf-8'
      })
      return output.includes('OBS Virtual Camera') || output.includes('OBS-Camera')
    } catch (err: any) {
      // FFmpeg exits with error code when listing devices, but output is in stderr
      const output = err.stderr || err.stdout || ''
      return output.includes('OBS Virtual Camera') || output.includes('OBS-Camera')
    }
  }

  /**
   * Check if FFmpeg is available.
   */
  isFFmpegAvailable(): boolean {
    try {
      execSync('ffmpeg -version', { timeout: 3000 })
      return true
    } catch {
      return false
    }
  }

  /**
   * Start capturing the player window and outputting to OBS Virtual Camera.
   * Uses FFmpeg gdigrab to capture a window by title.
   */
  start(windowTitle: string = 'Player'): void {
    if (this.running) return

    if (!this.isFFmpegAvailable()) {
      this.emit('error', 'FFmpeg not found. Please install FFmpeg.')
      return
    }

    if (!this.isOBSVirtualCameraInstalled()) {
      this.emit('error', 'OBS Virtual Camera not found. Please install OBS Studio and enable Virtual Camera.')
      return
    }

    // gdigrab captures a window by title, output to OBS Virtual Camera via DirectShow
    const cmd = [
      'ffmpeg',
      '-f', 'gdigrab',
      '-framerate', '25',
      '-i', `title="${windowTitle}"`,
      '-vf', 'scale=480:720',
      '-f', 'dshow',
      '-vcodec', 'rawvideo',
      '-pix_fmt', 'yuyv422',
      '"video=OBS Virtual Camera"'
    ].join(' ')

    this.process = exec(cmd)
    this.running = true

    this.process.on('exit', (code) => {
      this.running = false
      this.process = null
      if (code !== 0 && code !== null) {
        this.emit('error', `FFmpeg exited with code ${code}`)
      }
      this.emit('stopped')
    })

    this.process.stderr?.on('data', (data: string) => {
      // FFmpeg outputs progress info to stderr
      if (data.includes('Error') || data.includes('error')) {
        this.emit('error', data.trim())
      }
    })

    this.emit('started')
  }

  stop(): void {
    if (this.process) {
      this.process.kill('SIGTERM')
      this.process = null
    }
    this.running = false
    this.emit('stopped')
  }

  isRunning(): boolean {
    return this.running
  }

  getStatus(): { running: boolean; ffmpegAvailable: boolean; obsInstalled: boolean } {
    return {
      running: this.running,
      ffmpegAvailable: this.isFFmpegAvailable(),
      obsInstalled: this.isOBSVirtualCameraInstalled()
    }
  }
}

export const virtualCameraService = new VirtualCameraService()
