import { ComponentElement } from '@locomotivemtl/component-manager';
import { OglWheelVega } from '@scripts/webgl/components/OglWheelVega/OglWheelVega';
import { CanvasElement } from '@scripts/webgl/web-component/CanvasElement';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { SplitText } from 'gsap/SplitText';
import gsap from 'gsap';

gsap.registerPlugin(ScrollTrigger);
gsap.registerPlugin(SplitText);

type LabelTarget = number | null;

const FADE = { duration: 0.2, ease: 'power1.out' } as const;

export class WheelVega extends HTMLElement {
    private canvas: CanvasElement | null = null;
    private oglWheelVega: OglWheelVega | null = null;
    private group: HTMLElement | null = null;
    private plants: HTMLElement | null = null;
    private ingredients: HTMLElement[] = [];
    private powered: HTMLElement | null = null;
    private build: HTMLElement | null = null;
    /** Label in the flow. `null` is Plants. */
    private shown: LabelTarget = null;
    /** Latest requested label. Replaces any in-flight target. */
    private pending: LabelTarget | undefined = undefined;
    private phase: 'idle' | 'out' | 'in' = 'idle';
    private fade?: gsap.core.Tween;
    private visiblePartTimeline?: gsap.core.Timeline;
    private introTimeline?: gsap.core.Timeline;

    connectedCallback(): void {
        this.group = this.querySelector<HTMLElement>('[data-wheel="group"]');
        this.plants = this.querySelector<HTMLElement>('[data-wheel-label="plants"]');
        this.ingredients = Array.from(
            this.querySelectorAll<HTMLElement>('[data-wheel="ingredient"]')
        );
        this.powered = this.querySelector<HTMLElement>('[data-wheel="powered"]');
        this.build = this.querySelector<HTMLElement>('[data-wheel="build"]');
        this.addEventListener('wheel-nearest', this.onNearest);

        this.bindWheel();
        this.animIntro();
    }

    disconnectedCallback(): void {
        this.unbindWheel();
        this.killFades();
        this.removeEventListener('wheel-nearest', this.onNearest);
        this.plants = null;
        this.ingredients = [];
        this.pending = undefined;
        this.phase = 'idle';
    }

    /** Use `OglWheelVega` only after its canvas has finished mounting. */
    private bindWheel(): void {
        this.canvas = this.querySelector<CanvasElement>("[data-component-id='OglWheelVega']");
        const wheel = this.canvas?.component as OglWheelVega | undefined;

        if (wheel?.isMounted) {
            this.oglWheelVega = wheel;
            return;
        }

        this.canvas?.addEventListener(CanvasElement.EVENTS.CANVAS_MOUNTED, this.onCanvasMounted);
    }

    private onCanvasMounted = (event: Event): void => {
        const { component } = (event as CustomEvent<{ component: OglWheelVega }>).detail;
        this.oglWheelVega = component;
        const trigger = this.oglWheelVega.parentElement;

        this.visiblePartTimeline = gsap.timeline({
            scrollTrigger: {
                trigger,
                start: 'top top',
                end: () =>
                    `+=${trigger.offsetHeight * this.oglWheelVega.planes.circle.visiblePartScroll}`,
                scrub: 0.4,
                invalidateOnRefresh: true
            }
        });
        this.visiblePartTimeline
            .fromTo(
                this.group,
                { y: 0 },
                {
                    y:
                        trigger.offsetHeight *
                        this.oglWheelVega.planes.circle.visiblePartScroll *
                        0.15,
                    duration: 1,
                    ease: 'power2.out'
                }
            )
            .fromTo(
                this.powered,
                { xPercent: 0 },
                { xPercent: -200, duration: 1, ease: 'power2.out' },
                '<'
            )
            .fromTo(
                this.build,
                { xPercent: 0 },
                { xPercent: 200, duration: 1, ease: 'power2.out' },
                '<'
            );
    };

    private animIntro = (): void => {
        const wordsPowered = SplitText.create(this.powered, { type: 'words' });
        const wordsBuild = SplitText.create(this.build, { type: 'words' });
        const staggerAmount = 0.1;
        this.introTimeline = gsap
            .timeline({ delay: 1.5 })
            .fromTo(
                wordsPowered.words,
                { yPercent: 100 },
                { yPercent: 0, duration: 1, ease: 'power2.out', stagger: staggerAmount }
            )
            .fromTo(
                this.plants,
                { opacity: 0 },
                { opacity: 1, duration: 1, ease: 'power2.out' },
                '-=.75'
            )
            .fromTo(
                wordsBuild.words,
                { yPercent: 100 },
                { yPercent: 0, duration: 1, ease: 'power2.out', stagger: staggerAmount },
                '-=.75'
            );
    };

    private unbindWheel(): void {
        this.canvas?.removeEventListener(CanvasElement.EVENTS.CANVAS_MOUNTED, this.onCanvasMounted);
        this.canvas = null;
        this.oglWheelVega = null;
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
        this.pending = target;
        if (this.phase === 'idle') this.startOut();
    };

    /** Fade out the label in the flow. A newer `pending` is applied when this ends. */
    private startOut(): void {
        if (this.pending === this.shown) {
            this.pending = undefined;
            this.phase = 'idle';
            return;
        }

        const current = this.labelFor(this.shown);
        this.phase = 'out';
        this.fade = gsap.to(current, {
            autoAlpha: 0,
            ...FADE,
            overwrite: 'auto',
            onComplete: () => this.fadeInPending()
        });
    }

    /** Fade in the latest pending label. A different outgoing line leaves the flow first. */
    private fadeInPending(): void {
        const target = this.pending as LabelTarget;
        const incoming = this.labelFor(target);
        const outgoing = this.labelFor(this.shown);

        this.shown = target;
        this.phase = 'in';

        if (outgoing !== incoming) {
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
        this.phase = 'idle';
        this.fade = undefined;
        if (this.pending !== this.shown) this.startOut();
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

    private labelFor(target: LabelTarget): HTMLElement {
        if (target === null) return this.plants as HTMLElement;
        return this.ingredients[target];
    }
}

customElements.define('c-wheel-vega', ComponentElement(WheelVega, 'WheelVega'));
