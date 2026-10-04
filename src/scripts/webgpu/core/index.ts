export { $CanvasManagerLogger } from '../utils/logger.ts';
export { CanvasComponent } from './CanvasComponent.ts';
export { $CanvasManager, $CanvasManagerError } from './CanvasManager.ts';
export type {
    CanvasManagerClock,
    CanvasManagerParameters,
    CanvasManagerPlugin,
    CanvasManagerStats,
    Resolution
} from './CanvasManager.ts';
export { PixelManager } from './PixelManager.ts';
export { RendererPool } from './RendererPool.ts';
export type {
    RendererEntry,
    RendererEntryData,
    RendererFactory,
    RendererPoolStats
} from './RendererPool.ts';
