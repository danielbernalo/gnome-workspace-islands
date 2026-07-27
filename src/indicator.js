/**
 * Workspace indicator.
 *
 * GNOME 48 replaced the "Activities" label with a row of dots that stretch and
 * fade as you move between workspaces. This module puts virtual workspaces into
 * *that* widget rather than adding a second one beside it, so the panel keeps
 * showing exactly one workspace indicator and the extension leaves no visible
 * trace of itself.
 *
 * What it shows follows the focused monitor, which is the same rule the
 * keyboard shortcuts already use:
 *
 *   focus on the primary monitor    native workspaces, unchanged behaviour
 *   focus on a secondary monitor    that monitor's virtual workspaces
 *
 * Two things about the shell make this work the way it does.
 *
 * `WorkspaceDot` and `WorkspaceIndicators` are module-private consts in
 * panel.js — no export, so they cannot be imported and are reimplemented here.
 * The consequence that matters is in teardown: the shell's own indicator is
 * *hidden*, never destroyed. There would be no way to build a replacement.
 *
 * Living inside the Activities button is not incidental either. The theme
 * scopes its rules to `#panel .panel-button#panelActivities` — both the dot
 * styling and the box spacing. Parented anywhere else these dots would render
 * unstyled; parented here they are the shell's own pixels.
 *
 * Everything is driven by an St.Adjustment whose value is *fractional*, exactly
 * as panel.js does it. Today only whole numbers are ever written to it. It is
 * built this way because that adjustment is the seam a touchpad gesture plugs
 * into: a swipe writes fractional progress, and the dots deform continuously
 * without this module changing at all.
 */

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { lerp } from 'resource:///org/gnome/shell/misc/util.js';

/** Inactive dots are drawn slightly smaller. Matches panel.js. */
const INACTIVE_DOT_SCALE = 0.75;

/** How much the active dot stretches, by dot count. Matches panel.js. */
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

        // The style class is the shell's, and so is the rule that paints it.
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

    // Width is what carries the animation: the active dot grows into a pill,
    // and a half-way expansion gives a half-way width. That is why a fractional
    // adjustment value reads as motion rather than as a jump.
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

    /**
     * The adjustment other code drives. Exposed so a gesture can bind straight
     * to it instead of pushing discrete values through set().
     *
     * @returns {St.Adjustment}
     */
    get adjustment() {
        return this._adjustment;
    }

    /**
     * @param {number} count how many dots
     * @param {number} value active workspace; fractional values are the point
     */
    set(count, value) {
        // Order matters: St.Adjustment clamps value against upper, so raising
        // the count has to happen before a value that only the new count allows.
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
    /**
     * @param {object} opts
     * @param {() => (object|null)} opts.getFocusedState MonitorState for the
     *   focused monitor, or null when focus is on the primary one
     */
    constructor({ getFocusedState }) {
        this._getFocusedState = getFocusedState;
        this._dots = null;
        this._nativeDots = null;
        this._signals = [];
        this._preview = null;

        // Follows the shell's own workspace state, fractional value included,
        // so time spent on the primary monitor looks untouched — because it is.
        //
        // The argument must be a real Clutter.Actor: createWorkspacesAdjustment
        // passes it to `new St.Adjustment({actor})`, and a plain JS object gets
        // "This JS object wrapper isn't wrapping a GObject" at enable() time.
        // panel.js can pass `this` because there `this` *is* the actor; this
        // class is not one. The stage is used rather than the dots because it
        // outlives them — the panel is rebuilt on session mode changes, and the
        // adjustment must not die with it. It is only a frame-clock owner; the
        // registry that tracks it holds a WeakRef, so nothing is pinned.
        this._nativeAdjustment = Main.createWorkspacesAdjustment(global.stage);

        this._connect(this._nativeAdjustment, 'notify::value', () => this.sync());
        this._connect(this._nativeAdjustment, 'notify::upper', () => this.sync());
        this._connect(global.display, 'notify::focus-window', () => this.sync());

        // The panel is rebuilt on session mode changes, which takes our child
        // with it and brings the shell's back. Re-attaching is idempotent.
        this._connect(Main.sessionMode, 'updated', () => this._attach());

        this._attach();
    }

    /** Repaint from current state. Cheap enough to call on every change. */
    sync() {
        if (!this._dots)
            return;

        // A swipe in progress is the most current thing there is. Focus and
        // workspace signals keep firing under it, and every one of them would
        // otherwise snap the dots back to a whole number mid-gesture.
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

    /**
     * Follow a switch as it happens.
     *
     * The fractional value is the whole point: `expansion` is computed as
     * `1 - |index - value|`, so a half-finished swipe leaves two dots half
     * stretched. Pass null to hand control back to sync().
     *
     * @param {object} state
     * @param {number|null} value fractional workspace index
     */
    setPreview(state, value) {
        this._preview = value === null ? null : { state, value };
        this.sync();
    }

    /**
     * Take over the Activities button.
     *
     * The shell's indicator is hidden rather than removed, and this is not
     * politeness: WorkspaceIndicators is module-private, so a destroyed one
     * could never be rebuilt and the panel would be left permanently altered.
     */
    _attach() {
        if (this._dots?.get_parent())
            return;

        const activities = Main.panel.statusArea?.activities;
        if (!activities) {
            // Some session modes have no Activities button. Nothing to take
            // over, and nothing worth failing over either.
            this._dots = null;
            this._nativeDots = null;
            return;
        }

        // Excluding our own: after a panel rebuild this runs again, and picking
        // up a leftover Dots as "the native one" would hide the wrong widget.
        this._nativeDots = activities.get_children()
            .find(child => child !== this._dots && child instanceof St.BoxLayout)
            ?? null;
        this._nativeDots?.hide();

        this._dots = new Dots();

        // Index 0, not add_child(). PanelMenu.ButtonBox.vfunc_allocate takes
        // `get_first_child()` and allocates that one alone — an appended child
        // is laid out by nobody, and its subtree logs "needs an allocation"
        // forever while painting nothing.
        //
        // It also means the hidden native dots must stay in the tree at index
        // 1 rather than being removed: destroying ours on unload makes them the
        // first child again, and show() puts the panel back exactly as found.
        activities.insert_child_at_index(this._dots, 0);

        this.sync();
    }

    destroy() {
        for (const [object, id] of this._signals)
            object.disconnect(id);
        this._signals = [];

        this._dots?.destroy();
        this._dots = null;

        // Unconditional: a panel left with no workspace indicator at all is a
        // worse outcome than anything this extension does while running.
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
