import { app, BrowserWindow, ipcMain, globalShortcut, desktopCapturer, screen, session } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import started from 'electron-squirrel-startup';
import dotenv from 'dotenv';

const loadEnv = () => {
  const envPaths = [
    path.join(process.cwd(), '.env'),
    path.join(path.dirname(process.execPath), '.env'),
    path.join(process.resourcesPath || '', '.env'),
  ];

  for (const envPath of envPaths) {
    if (fs.existsSync(envPath)) {
      dotenv.config({ path: envPath });
      return;
    }
  }

  dotenv.config();
};

loadEnv();

if (started) {
  app.quit();
}

let mainWindow;

const createWindow = () => {
  mainWindow = new BrowserWindow({
    width: 420,
    height: 600,
    alwaysOnTop: true,
    frame: false,
    transparent: true,
    skipTaskbar: true,
    hasShadow: false,
    focusable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Default: Screen capture protection ON
  mainWindow.setContentProtection(true);

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }
};

// --- Screen Capture IPC Handler ---
ipcMain.handle('capture-screen', async () => {
  try {
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width, height } = primaryDisplay.size;

    // Keep snap payloads small enough for fast vision requests.
    const maxDimension = 960;
    const scale = Math.min(1, maxDimension / width);
    const targetWidth = Math.round(width * scale);
    const targetHeight = Math.round(height * scale);

    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: targetWidth,
        height: targetHeight,
      },
    });

    if (sources.length > 0) {
      const image = sources[0].thumbnail.toJPEG(50);
      return `data:image/jpeg;base64,${image.toString('base64')}`;
    }
    return null;
  } catch (error) {
    console.error('Error capturing screen:', error);
    return null;
  }
});

// IPC Handlers
ipcMain.handle('get-env', () => {
  return {
    DEEPGRAM_API_KEY: process.env.DEEPGRAM_API_KEY || '',
    GROQ_API_KEY: process.env.GROQ_API_KEY || '',
  };
});

ipcMain.on('toggle-protection', (_, enable) => {
  if (mainWindow) mainWindow.setContentProtection(enable);
});

ipcMain.on('set-opacity', (_, value) => {
  if (mainWindow) mainWindow.setOpacity(parseFloat(value));
});

ipcMain.on('minimize-window', () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.on('close-window', () => {
  if (mainWindow) mainWindow.close();
});

app.whenReady().then(() => {
  // CRITICAL FIX: Handle getDisplayMedia permission for System Loopback Audio
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
      // Automatically pick primary screen and enable loopback audio
      callback({ video: sources[0], audio: 'loopback' });
    }).catch(() => {
      callback({});
    });
  });
  if (process.platform === 'darwin') {
    app.dock.hide();
  }
  createWindow();

  // Register an emergency emergency quit/toggle hotkey (Ctrl+Shift+X)
  globalShortcut.register('CommandOrControl+Shift+X', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.hide();
      } else {
        mainWindow.showInactive(); // Show without taking focus
      }
    }
  });

  // Global screen-snap hotkey (Ctrl + Shift + S)
  globalShortcut.register('CommandOrControl+Shift+S', () => {
    if (mainWindow) {
      mainWindow.webContents.send('trigger-screen-capture');
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
