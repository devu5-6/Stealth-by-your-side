import { app, BrowserWindow, ipcMain, globalShortcut, desktopCapturer, screen } from 'electron';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import dotenv from 'dotenv';

dotenv.config();

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

    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: width * primaryDisplay.scaleFactor,
        height: height * primaryDisplay.scaleFactor,
      },
    });

    if (sources.length > 0) {
      // Returns clean base64 image (overlay is excluded due to setContentProtection)
      const image = sources[0].thumbnail.toJPEG(80);
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