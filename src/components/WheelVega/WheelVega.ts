import { ComponentElement } from '@locomotivemtl/component-manager';
import gsap from 'gsap';

type LabelTarget = number | null;

const FADE = { duration: 0.2, ease: 'power1.out' } as const;

export class WheelVega extends HTMLElement {
    private plants: HTMLElement | null = null;
    private ingredients: HTMLElement[] = [];
    /** Label in the flow. `null` is Plants. */
    private shown: LabelTarget = null;
    /** Latest requested label. Replaces any in-flight target. */
    private pending: LabelTarget | undefined = undefined;
    private phase: 'idle' | 'out' | 'in' = 'idle';
    private fade?: gsap.core.Tween;

    connectedCallback(): void {
        this.plants = this.querySelector<HTMLElement>('[data-wheel-label="plants"]');
        this.ingredients = Array.from(
            this.querySelectorAll<HTMLElement>('[data-wheel="ingredient"]')
        );
        this.addEventListener('wheel-nearest', this.onNearest);
    }

    disconnectedCallback(): void {
        this.killFades();
        this.removeEventListener('wheel-nearest', this.onNearest);
        this.plants = null;
        this.ingredients = [];
        this.pending = undefined;
        this.phase = 'idle';
    }

    private onNearest = (event: Event): void => {
        if (!(event instanceof CustomEvent)) return;

        const detail = event.detail as { index?: LabelTarget; immediate?: boolean };
        if (!detail || !('index' in detail)) return;
        if (detail.immediate) {
            this.snapToPlants();
            return;
        }

        const target = detail.index ?? null;
        if (typeof target === 'number' && !this.ingredients[target]) return;

        this.pending = target;
        if (this.phase === 'idle') this.startOut();
    };

    /** Fade out the label in the flow. A newer `pending` is applied when this ends. */
    private startOut(): void {
        if (this.pending === undefined || this.pending === this.shown) {
            this.pending = undefined;
            this.phase = 'idle';
            return;
        }

        const current = this.labelFor(this.shown);
        if (!current) {
            this.fadeInPending();
            return;
        }

        this.phase = 'out';
        const opacity = Number(gsap.getProperty(current, 'opacity'));
        if (opacity <= 0.001) {
            this.fadeInPending();
            return;
        }

        this.fade = gsap.to(current, {
            autoAlpha: 0,
            ...FADE,
            overwrite: 'auto',
            onComplete: () => {
                if (this.phase !== 'out') return;
                this.fadeInPending();
            }
        });
    }

    /** Fade in the latest pending label. The outgoing line leaves the flow first. */
    private fadeInPending(): void {
        const target = this.pending;
        const incoming = target === undefined ? null : this.labelFor(target);
        if (target === undefined || !incoming) {
            this.phase = 'idle';
            this.fade = undefined;
            return;
        }

        const outgoing = this.labelFor(this.shown);
        this.shown = target;
        this.phase = 'in';

        if (outgoing && outgoing !== incoming) {
            gsap.set(outgoing, { autoAlpha: 0 });
            outgoing.dataset.state = 'hidden';
        }

        gsap.set(incoming, { autoAlpha: 0 });
        incoming.dataset.state = 'shown';
        this.fade = gsap.to(incoming, {
            autoAlpha: 1,
            ...FADE,
            overwrite: 'auto',
            onComplete: () => this.finishIn()
        });
    }

    private finishIn(): void {
        if (this.phase !== 'in') return;

        this.phase = 'idle';
        this.fade = undefined;
        if (this.pending !== undefined && this.pending !== this.shown) this.startOut();
        else this.pending = undefined;
    }

    /** Kill the running fade, show Plants, hide the names. */
    private snapToPlants(): void {
        this.phase = 'idle';
        this.pending = undefined;
        this.shown = null;
        this.killFades();

        if (this.plants) {
            this.plants.dataset.state = 'shown';
            gsap.set(this.plants, { autoAlpha: 1 });
        }
        for (const ingredient of this.ingredients) {
            ingredient.dataset.state = 'hidden';
            gsap.set(ingredient, { autoAlpha: 0 });
        }
    }

    private killFades(): void {
        this.fade?.kill();
        this.fade = undefined;
        const labels = [this.plants, ...this.ingredients].filter(
            (label): label is HTMLElement => !!label
        );
        if (labels.length) gsap.killTweensOf(labels);
    }

    private labelFor(target: LabelTarget): HTMLElement | null {
        if (target === null) return this.plants;
        return this.ingredients[target] ?? null;
    }
}

customElements.define('c-wheel-vega', ComponentElement(WheelVega, 'WheelVega'));
