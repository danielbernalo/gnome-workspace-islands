// Lives inside the Activities button because the theme scopes the dot rules to #panelActivities.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { lerp } from 'resource:///org/gnome/shell/misc/util.js';

const INACTIVE_DOT_SCALE = 0.75;

const WIDTH_MULTIPLIERS = [
    { upTo: 2, multiplier: 3.625 },
    { upTo: 5, multiplier: 3.25 },
    { upTo: Infinity, multiplier: 2.75 },
];

const DOT_SCALE_DURATION = 500;

const WorkspaceDot = GObject.registerClass({
    Properties: {
        'expansion': GObject.ParamSpec.double('expansion', null, null,
            GObject.ParamFlags.READWRITE,
            0.0, 1.0, 0.0),
        'width-multiplier': GObject.ParamSpec.double(
            'width-multiplier', null, null,
            GObject.ParamFlags.READWRITE,
            1.0, 10.0, 1.0),
    },
}, class IslandsDot extends Clutter.Actor {
    constructor(params = {}) {
        super({
            pivot_point: new Graphene.Point({ x: 0.5, y: 0.5 }),
            ...params,
        });

        this._dot = new St.Widget({
            style_class: 'workspace-dot',
            y_align: Clutter.ActorAlign.CENTER,
            pivot_point: new Graphene.Point({ x: 0.5, y: 0.5 }),
            request_mode: Clutter.RequestMode.WIDTH_FOR_HEIGHT,
        });
        this.add_child(this._dot);

        this._destroying = false;

        this.connect('notify::width-multiplier', () => this.queue_relayout());
        this.connect('notify::expansion', () => {
            this._updateVisuals();
            this.queue_relayout();
        });
        this._updateVisuals();
    }

    get destroying() {
        return this._destroying;
    }

    _updateVisuals() {
        const { expansion } = this;

        this._dot.set({
            opacity: lerp(0.50, 1.0, expansion) * 255,
            scaleX: lerp(INACTIVE_DOT_SCALE, 1.0, expansion),
            scaleY: lerp(INACTIVE_DOT_SCALE, 1.0, expansion),
        });
    }

    vfunc_get_preferred_width(forHeight) {
        const factor = lerp(1.0, this.widthMultiplier, this.expansion);
        return this._dot.get_preferred_width(forHeight)
            .map(value => Math.round(value * factor));
    }

    vfunc_get_preferred_height(forWidth) {
        return this._dot.get_preferred_height(forWidth);
    }

    vfunc_allocate(box) {
        this.set_allocation(box);

        box.set_origin(0, 0);
        this._dot.allocate(box);
    }

    scaleIn() {
        this.set({ scale_x: 0, scale_y: 0 });

        this.ease({
            duration: DOT_SCALE_DURATION,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            scale_x: 1.0,
            scale_y: 1.0,
        });
    }

    scaleOutAndDestroy() {
        this._destroying = true;

        this.ease({
            duration: DOT_SCALE_DURATION,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            scale_x: 0.0,
            scale_y: 0.0,
            onComplete: () => this.destroy(),
        });
    }
});

const Dots = GObject.registerClass(
class IslandsDots extends St.BoxLayout {
    _init() {
        super._init();

        this._adjustment = new St.Adjustment({
            actor: this,
            lower: 0,
            upper: 1,
            value: 0,
            step_increment: 1,
            page_increment: 1,
        });

        this._adjustmentIds = [
            this._adjustment.connect('notify::value',
                () => this._updateExpansion()),
            this._adjustment.connect('notify::upper',
                () => this._recalculateDots()),
        ];

        this.connect('destroy', () => this._onDestroy());

        this._recalculateDots();
    }

    get adjustment() {
        return this._adjustment;
    }

    set(count, value) {
        // St.Adjustment clamps value against upper, so upper has to be raised first.
        this._adjustment.upper = Math.max(count, 1);
        this._adjustment.value = value;
    }

    _liveDots() {
        return [...this].filter(dot => !dot.destroying);
    }

    _recalculateDots() {
        const live = this._liveDots();
        const target = this._adjustment.upper;

        let remaining = Math.abs(live.length - target);
        while (remaining--) {
            if (live.length < target) {
                const dot = new WorkspaceDot();
                this.add_child(dot);
                dot.scaleIn();
            } else {
                live[live.length - remaining - 1].scaleOutAndDestroy();
            }
        }

        this._updateExpansion();
    }

    _updateExpansion() {
        const count = this._liveDots().length;
        const active = this._adjustment.value;

        const { multiplier } = WIDTH_MULTIPLIERS.find(m => count <= m.upTo);

        this.get_children().forEach((dot, index) => {
            const distance = Math.abs(index - active);
            dot.expansion = clamp(1 - distance, 0, 1);
            dot.widthMultiplier = multiplier;
        });
    }

    _onDestroy() {
        for (const id of this._adjustmentIds)
            this._adjustment.disconnect(id);

        this._adjustmentIds = [];
    }
});

export class Indicator {
    constructor({ getFocusedState }) {
        this._getFocusedState = getFocusedState;
        this._dots = null;
        this._nativeDots = null;
        this._signals = [];
        this._preview = null;

        // createWorkspacesAdjustment needs a real actor; the stage outlives panel rebuilds.
        this._nativeAdjustment = Main.createWorkspacesAdjustment(global.stage);

        this._connect(this._nativeAdjustment, 'notify::value', () => this.sync());
        this._connect(this._nativeAdjustment, 'notify::upper', () => this.sync());
        this._connect(global.display, 'notify::focus-window', () => this.sync());

        // Session mode changes can rebuild the panel; re-attaching is idempotent and cheap.
        this._connect(Main.sessionMode, 'updated', () => this._attach());

        this._attach();
    }

    sync() {
        if (!this._dots)
            return;

        // A swipe in progress wins, or focus and workspace signals would snap the dots mid-gesture.
        if (this._preview) {
            const { state, value } = this._preview;
            this._dots.set(state.size, value);
            return;
        }

        const state = this._getFocusedState();

        if (state)
            this._dots.set(state.size, state.activeIndex);
        else
            this._dots.set(this._nativeAdjustment.upper, this._nativeAdjustment.value);
    }

    setPreview(state, value) {
        this._preview = value === null ? null : { state, value };
        this.sync();
    }

    // The shell's indicator is hidden, never destroyed: WorkspaceIndicators is private to panel.js.
    _attach() {
        if (this._dots?.get_parent())
            return;

        // A panel rebuild can unparent ours without destroying it, which would leak it.
        this._dots?.destroy();
        this._dots = null;

        const activities = Main.panel.statusArea?.activities;
        if (!activities) {
            this._dots = null;
            this._nativeDots = null;
            return;
        }

        // Skip our own, or a leftover Dots after a panel rebuild would be hidden as the native one.
        this._nativeDots = activities.get_children()
            .find(child => child !== this._dots && child instanceof St.BoxLayout)
            ?? null;
        this._nativeDots?.hide();

        this._dots = new Dots();

        // Index 0: ButtonBox allocates only its first child, and native dots regain it on unload.
        activities.insert_child_at_index(this._dots, 0);

        this.sync();
    }

    destroy() {
        for (const [object, id] of this._signals)
            object.disconnect(id);
        this._signals = [];

        this._dots?.destroy();
        this._dots = null;

        this._nativeDots?.show();
        this._nativeDots = null;

        this._nativeAdjustment = null;
        this._getFocusedState = null;
    }

    _connect(object, signal, callback) {
        this._signals.push([object, object.connect(signal, callback)]);
    }
}

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}
