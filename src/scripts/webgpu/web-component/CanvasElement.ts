import { ComponentElement } from '@locomotivemtl/component-manager';

import type { CanvasComponent } from '../core/CanvasComponent.ts';
import { $CanvasManager } from '../core/CanvasManager.ts';

export class CanvasElement extends HTMLElement {
    static readonly EVENTS = {
        CANVAS_MOUNTED: 'onCanvasMounted',
        CANVAS_UNMOUNTED: 'onCanvasUnmounted'
    } as const;

    private componentId = '';
    private mountToken = 0;
    private unsubRegistration: (() => void) | null = null;
    private $slotWrapper: HTMLElement | null = null;

    public component!: CanvasComponent;
    public datas: Record<string, string> = {};

    async connectedCallback() {
        const token = ++this.mountToken;

        // Read attributes here (not in the constructor) so document.createElement + setAttribute works
        this.componentId = this.getAttribute('data-component-id') ?? '';
        this.datas = {};
        for (let i = 0; i < this.attributes.length; i++) {
            const attr = this.attributes[i];
            if (
                attr.name.startsWith('data-') &&
                attr.name !== 'data-component-id' &&
                !attr.name.includes('astro-')
            ) {
                this.datas[attr.name.slice('data-'.length)] = attr.value;
            }
        }

        this.$slotWrapper = this.querySelector('[data-slot-wrapper]');

        if (!$CanvasManager.has(this.componentId)) {
            await new Promise<void>((resolve) => {
                this.unsubRegistration = $CanvasManager.hooks.onComponentRegistered.listen(
                    ({ id }) => {
                        if (id === this.componentId.toLowerCase()) {
                            this.unsubRegistration?.();
                            this.unsubRegistration = null;
                            resolve();
                        }
                    }
                );
            });
            if (token !== this.mountToken || !this.isConnected) return;
        }

        const component = await $CanvasManager.get(this.componentId);

        // disconnected (or reconnected) while awaiting get()
        if (token !== this.mountToken || !this.isConnected) {
            $CanvasManager.release(component);
            return;
        }
        this.component = component;
        this.component.datas = this.datas;
        this.dataset.uuid = component.uuid;

        await component.mount(this);

        // disconnected while awaiting mount()
        if (token !== this.mountToken || !this.isConnected) {
            $CanvasManager.release(component);
            component.unmount();
            return;
        }

        // Drop the loading cover only after a successful mount — a disconnect mid-mount keeps it for re-connects
        this.$slotWrapper?.remove();

        this.dispatchEvent(
            new CustomEvent(CanvasElement.EVENTS.CANVAS_MOUNTED, {
                detail: { component }
            })
        );
    }

    disconnectedCallback() {
        this.mountToken++; // cancel any in-flight connect
        this.unsubRegistration?.();
        this.unsubRegistration = null;
        if (!this.component) return;
        $CanvasManager.release(this.component);
        this.component.unmount();
        this.dispatchEvent(
            new CustomEvent(CanvasElement.EVENTS.CANVAS_UNMOUNTED, {
                detail: { component: this.component }
            })
        );
    }
}

// A distinct tag and component name: `webgl/` already claimed `c-loco-canvas` and `CanvasElement`,
// and a second registration under either name throws once both folders are loaded.
if (!customElements.get('c-webgpu-canvas')) {
    customElements.define(
        'c-webgpu-canvas',
        ComponentElement(CanvasElement, 'WebgpuCanvasElement')
    );
}
