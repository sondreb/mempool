import { Component, ElementRef, ViewChild, HostListener, Input, Output, EventEmitter, NgZone, AfterViewInit, OnDestroy, OnChanges } from '@angular/core';
import { TransactionStripped } from '../../interfaces/websocket.interface';
import { FastVertexArray } from './fast-vertex-array';
import BlockScene from './block-scene';
import TxSprite from './tx-sprite';
import TxView from './tx-view';
import { Color, Position } from './sprite-types';
import { Price } from '../../services/price.service';
import { StateService } from '../../services/state.service';
import { Subscription } from 'rxjs';
import { defaultColorFunction, setOpacity, defaultFeeColors, defaultAuditFeeColors, defaultMarginalFeeColors, defaultAuditColors } from './utils';
import { ActiveFilter, FilterMode, toFlags } from '../../shared/filters.utils';
import { detectWebGL } from '../../shared/graphs.utils';

const unmatchedOpacity = 0.2;
const unmatchedFeeColors = defaultFeeColors.map(c => setOpacity(c, unmatchedOpacity));
const unmatchedAuditFeeColors = defaultAuditFeeColors.map(c => setOpacity(c, unmatchedOpacity));
const unmatchedMarginalFeeColors = defaultMarginalFeeColors.map(c => setOpacity(c, unmatchedOpacity));
const unmatchedAuditColors = {
  censored: setOpacity(defaultAuditColors.censored, unmatchedOpacity),
  missing: setOpacity(defaultAuditColors.missing, unmatchedOpacity),
  added: setOpacity(defaultAuditColors.added, unmatchedOpacity),
  selected: setOpacity(defaultAuditColors.selected, unmatchedOpacity),
  accelerated: setOpacity(defaultAuditColors.accelerated, unmatchedOpacity),
};

@Component({
  selector: 'app-block-overview-graph',
  templateUrl: './block-overview-graph.component.html',
  styleUrls: ['./block-overview-graph.component.scss'],
})
export class BlockOverviewGraphComponent implements AfterViewInit, OnDestroy, OnChanges {
  @Input() isLoading: boolean;
  @Input() resolution: number;
  @Input() autofit: boolean = false;
  @Input() blockLimit: number;
  @Input() orientation = 'left';
  @Input() flip = true;
  @Input() animationDuration: number = 1000;
  @Input() animationOffset: number | null = null;
  @Input() disableSpinner = false;
  @Input() mirrorTxid: string | void;
  @Input() unavailable: boolean = false;
  @Input() auditHighlighting: boolean = false;
  @Input() showFilters: boolean = false;
  @Input() excludeFilters: string[] = [];
  @Input() filterFlags: bigint | null = null;
  @Input() filterMode: FilterMode = 'and';
  @Input() blockConversion: Price;
  @Input() overrideColors: ((tx: TxView) => Color) | null = null;
  @Output() txClickEvent = new EventEmitter<{ tx: TransactionStripped, keyModifier: boolean}>();
  @Output() txHoverEvent = new EventEmitter<string>();
  @Output() readyEvent = new EventEmitter();

  @ViewChild('blockCanvas')
  canvas: ElementRef<HTMLCanvasElement>;

  gl: WebGLRenderingContext;
  animationFrameRequest: number;
  animationHeartBeat: number;
  displayWidth: number;
  displayHeight: number;
  cssWidth: number;
  cssHeight: number;
  shaderProgram: WebGLProgram;
  vertexArray: FastVertexArray;
  running: boolean;
  scene: BlockScene;
  hoverTx: TxView | void;
  selectedTx: TxView | void;
  highlightTx: TxView | void;
  mirrorTx: TxView | void;
  tooltipPosition: Position;

  readyNextFrame = false;

  searchText: string;
  searchSubscription: Subscription;
  filtersAvailable: boolean = true;
  activeFilterFlags: bigint | null = null;

  webGlEnabled = true;

  constructor(
    readonly ngZone: NgZone,
    readonly elRef: ElementRef,
    public stateService: StateService,
  ) {
    this.webGlEnabled = this.stateService.isBrowser && detectWebGL();
    this.vertexArray = new FastVertexArray(512, TxSprite.dataSize);
    this.searchSubscription = this.stateService.searchText$.subscribe((text) => {
      this.searchText = text;
      this.updateSearchHighlight();
    });
  }

  ngAfterViewInit(): void {
    if (this.canvas) {
      this.canvas.nativeElement.addEventListener('webglcontextlost', this.handleContextLost, false);
      this.canvas.nativeElement.addEventListener('webglcontextrestored', this.handleContextRestored, false);
      this.gl = this.canvas.nativeElement.getContext('webgl');

      if (this.gl) {
        this.initCanvas();
        this.resizeCanvas();
      }
    }
  }

  ngOnChanges(changes): void {
    if (changes.orientation || changes.flip) {
      if (this.scene) {
        this.scene.setOrientation(this.orientation, this.flip);
      }
    }
    if (changes.mirrorTxid) {
      this.setMirror(this.mirrorTxid);
    }
    if (changes.auditHighlighting) {
      this.setHighlightingEnabled(this.auditHighlighting);
    }
    if (changes.overrideColor && this.scene) {
      this.scene.setColorFunction(this.overrideColors);
    }
    if ((changes.filterFlags || changes.showFilters || changes.filterMode)) {
      this.setFilterFlags();
    }
  }

  setFilterFlags(goggle?: ActiveFilter): void {
    this.filterMode = goggle?.mode || this.filterMode;
    this.activeFilterFlags = goggle?.filters ? toFlags(goggle.filters) : this.filterFlags;
    if (this.scene) {
      if (this.activeFilterFlags != null && this.filtersAvailable) {
        this.scene.setColorFunction(this.getFilterColorFunction(this.activeFilterFlags));
      } else {
        this.scene.setColorFunction(this.overrideColors);
      }
    }
    this.start();
  }

  ngOnDestroy(): void {
    if (this.animationFrameRequest) {
      cancelAnimationFrame(this.animationFrameRequest);
      clearTimeout(this.animationHeartBeat);
    }
    if (this.canvas) {
      this.canvas.nativeElement.removeEventListener('webglcontextlost', this.handleContextLost);
      this.canvas.nativeElement.removeEventListener('webglcontextrestored', this.handleContextRestored);
    }
  }

  clear(direction): void {
    this.exit(direction);
    this.hoverTx = null;
    this.selectedTx = null;
    this.onTxHover(null);
    this.start();
  }

  destroy(): void {
    if (this.scene) {
      this.scene.destroy();
      this.start();
    }
  }

  // initialize the scene without any entry transition
  setup(transactions: TransactionStripped[]): void {
    const filtersAvailable = transactions.reduce((flagSet, tx) => flagSet || tx.flags > 0, false);
    if (filtersAvailable !== this.filtersAvailable) {
      this.setFilterFlags();
    }
    this.filtersAvailable = filtersAvailable;
    if (this.scene) {
      this.scene.setup(transactions);
      this.readyNextFrame = true;
      this.start();
      this.updateSearchHighlight();
    }
  }

  enter(transactions: TransactionStripped[], direction: string): void {
    if (this.scene) {
      this.scene.enter(transactions, direction);
      this.start();
      this.updateSearchHighlight();
    }
  }

  exit(direction: string): void {
    if (this.scene) {
      this.scene.exit(direction);
      this.start();
      this.updateSearchHighlight();
    }
  }

  replace(transactions: TransactionStripped[], direction: string, sort: boolean = true, startTime?: number): void {
    if (this.scene) {
      this.scene.replace(transactions || [], direction, sort, startTime);
      this.start();
      this.updateSearchHighlight();
    }
  }

  update(add: TransactionStripped[], remove: string[], change: { txid: string, rate: number | undefined, acc: boolean | undefined }[], direction: string = 'left', resetLayout: boolean = false): void {
    if (this.scene) {
      this.scene.update(add, remove, change, direction, resetLayout);
      this.start();
      this.updateSearchHighlight();
    }
  }

  initCanvas(): void {
    if (!this.canvas || !this.gl) {
      return;
    }

    this.gl.clearColor(0.0, 0.0, 0.0, 0.0);
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);

    const shaderSet = [
      {
        type: this.gl.VERTEX_SHADER,
        src: vertShaderSrc
      },
      {
        type: this.gl.FRAGMENT_SHADER,
        src: fragShaderSrc
      }
    ];

    this.shaderProgram = this.buildShaderProgram(shaderSet);

    this.gl.useProgram(this.shaderProgram);

    // Set up alpha blending
    this.gl.enable(this.gl.BLEND);
    this.gl.blendFunc(this.gl.ONE, this.gl.ONE_MINUS_SRC_ALPHA);

    const glBuffer = this.gl.createBuffer();
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, glBuffer);

    /* SET UP SHADER ATTRIBUTES */
    Object.keys(attribs).forEach((key, i) => {
      attribs[key].pointer = this.gl.getAttribLocation(this.shaderProgram, key);
      this.gl.enableVertexAttribArray(attribs[key].pointer);
    });

    this.start();
  }

  handleContextLost(event): void {
    event.preventDefault();
    cancelAnimationFrame(this.animationFrameRequest);
    this.animationFrameRequest = null;
    this.running = false;
    this.gl = null;
  }

  handleContextRestored(event): void {
    if (this.canvas?.nativeElement) {
      this.gl = this.canvas.nativeElement.getContext('webgl');
      if (this.gl) {
        this.initCanvas();
      }
    }
  }

  @HostListener('window:resize', ['$event'])
  resizeCanvas(): void {
    if (this.canvas) {
      this.cssWidth = this.canvas.nativeElement.offsetParent.clientWidth;
      this.cssHeight = this.canvas.nativeElement.offsetParent.clientHeight;
      this.displayWidth = window.devicePixelRatio * this.cssWidth;
      this.displayHeight = window.devicePixelRatio * this.cssHeight;
      this.canvas.nativeElement.width = this.displayWidth;
      this.canvas.nativeElement.height = this.displayHeight;
      if (this.gl) {
        this.gl.viewport(0, 0, this.displayWidth, this.displayHeight);
      }
      if (this.scene) {
        this.scene.resize({ width: this.displayWidth, height: this.displayHeight, animate: false });
        this.start();
      } else {
        this.scene = new BlockScene({ width: this.displayWidth, height: this.displayHeight, resolution: this.resolution,
          blockLimit: this.blockLimit, orientation: this.orientation, flip: this.flip, vertexArray: this.vertexArray,
          highlighting: this.auditHighlighting, animationDuration: this.animationDuration, animationOffset: this.animationOffset,
        colorFunction: this.getColorFunction() });
        this.start();
      }
    }
  }

  compileShader(src, type): WebGLShader {
    if (!this.gl) {
      return;
    }
    const shader = this.gl.createShader(type);

    this.gl.shaderSource(shader, src);
    this.gl.compileShader(shader);

    if (!this.gl.getShaderParameter(shader, this.gl.COMPILE_STATUS)) {
      console.log(`Error compiling ${type === this.gl.VERTEX_SHADER ? 'vertex' : 'fragment'} shader:`);
      console.log(this.gl.getShaderInfoLog(shader));
    }
    return shader;
  }

  buildShaderProgram(shaderInfo): WebGLProgram {
    if (!this.gl) {
      return;
    }
    const program = this.gl.createProgram();

    shaderInfo.forEach((desc) => {
      const shader = this.compileShader(desc.src, desc.type);
      if (shader) {
        this.gl.attachShader(program, shader);
      }
    });

    this.gl.linkProgram(program);

    if (!this.gl.getProgramParameter(program, this.gl.LINK_STATUS)) {
      console.log('Error linking shader program:');
      console.log(this.gl.getProgramInfoLog(program));
    }

    return program;
  }

  start(): void {
    this.running = true;
    this.ngZone.runOutsideAngular(() => this.doRun());
  }

  doRun(): void {
    if (this.animationFrameRequest) {
      cancelAnimationFrame(this.animationFrameRequest);
    }
    this.animationFrameRequest = requestAnimationFrame(() => this.run());
  }

  run(now?: DOMHighResTimeStamp): void {
    if (!now) {
      now = performance.now();
    }
    // skip re-render if there's no change to the scene
    if (this.scene && this.gl) {
      /* SET UP SHADER UNIFORMS */
      // screen dimensions
      this.gl.uniform2f(this.gl.getUniformLocation(this.shaderProgram, 'screenSize'), this.displayWidth, this.displayHeight);
      // frame timestamp
      this.gl.uniform1f(this.gl.getUniformLocation(this.shaderProgram, 'now'), now);

      if (this.vertexArray.dirty) {
        /* SET UP SHADER ATTRIBUTES */
        Object.keys(attribs).forEach((key, i) => {
          this.gl.vertexAttribPointer(attribs[key].pointer,
          attribs[key].count,  // number of primitives in this attribute
          this.gl[attribs[key].type],  // type of primitive in this attribute (e.g. gl.FLOAT)
          false, // never normalised
          stride,   // distance between values of the same attribute
          attribs[key].offset);  // offset of the first value
        });

        const pointArray = this.vertexArray.getVertexData();

        if (pointArray.length) {
          this.gl.bufferData(this.gl.ARRAY_BUFFER, pointArray, this.gl.DYNAMIC_DRAW);
          this.gl.drawArrays(this.gl.TRIANGLES, 0, pointArray.length / TxSprite.vertexSize);
        }
        this.vertexArray.dirty = false;
      } else {
        const pointArray = this.vertexArray.getVertexData();
        if (pointArray.length) {
          this.gl.drawArrays(this.gl.TRIANGLES, 0, pointArray.length / TxSprite.vertexSize);
        }
      }

      if (this.readyNextFrame) {
        this.readyNextFrame = false;
        this.readyEvent.emit();
      }
    }

    /* LOOP */
    if (this.running && this.scene && now <= (this.scene.animateUntil + 500)) {
      this.doRun();
    } else {
      if (this.animationHeartBeat) {
        clearTimeout(this.animationHeartBeat);
      }
      this.animationHeartBeat = window.setTimeout(() => {
        this.start();
      }, 1000);
    }
  }

  @HostListener('document:click', ['$event'])
  clickAway(event) {
    if (!this.elRef.nativeElement.contains(event.target)) {
      const currentPreview = this.selectedTx || this.hoverTx;
      if (currentPreview && this.scene) {
        this.scene.setHover(currentPreview, false);
        this.start();
      }
      this.hoverTx = null;
      this.selectedTx = null;
      this.onTxHover(null);
    }
  }

  @HostListener('pointerup', ['$event'])
  onClick(event) {
    if (!this.canvas) {
      return;
    }
    if (event.target === this.canvas.nativeElement && event.pointerType === 'touch') {
      this.setPreviewTx(event.offsetX, event.offsetY, true);
    } else if (event.target === this.canvas.nativeElement) {
      const keyMod = event.shiftKey || event.ctrlKey || event.metaKey;
      const middleClick = event.which === 2 || event.button === 1;
      this.onTxClick(event.offsetX, event.offsetY, keyMod || middleClick);
    }
  }

  @HostListener('pointermove', ['$event'])
  onPointerMove(event) {
    if (!this.canvas) {
      return;
    }
    if (event.target === this.canvas.nativeElement) {
      this.setPreviewTx(event.offsetX, event.offsetY, false);
    } else {
      this.onPointerLeave(event);
    }
  }

  @HostListener('pointerleave', ['$event'])
  onPointerLeave(event) {
    if (event.pointerType !== 'touch') {
      this.setPreviewTx(-1, -1, true);
    }
  }

  setPreviewTx(cssX: number, cssY: number, clicked: boolean = false) {
    const x = cssX * window.devicePixelRatio;
    const y = cssY * window.devicePixelRatio;
    if (this.scene && (!this.selectedTx || clicked)) {
      this.tooltipPosition = {
        x: cssX,
        y: cssY
      };
      const selected = this.scene.getTxAt({ x, y });
      const currentPreview = this.selectedTx || this.hoverTx;

      if (selected !== currentPreview) {
        if (currentPreview && this.scene) {
          this.scene.setHover(currentPreview, false);
          this.start();
        }
        if (selected) {
          if (selected && this.scene) {
            this.scene.setHover(selected, true);
            this.start();
          }
          if (clicked) {
            this.selectedTx = selected;
          } else {
            this.hoverTx = selected;
            this.onTxHover(this.hoverTx ? this.hoverTx.txid : null);
          }
        } else {
          if (clicked) {
            this.selectedTx = null;
          }
          this.hoverTx = null;
          this.onTxHover(null);
        }
      } else if (clicked) {
        if (selected === this.selectedTx) {
          this.hoverTx = this.selectedTx;
          this.selectedTx = null;
          this.onTxHover(this.hoverTx ? this.hoverTx.txid : null);
        } else {
          this.selectedTx = selected;
        }
      }
    }
  }

  setMirror(txid: string | void) {
    if (this.mirrorTx) {
      this.scene.setHover(this.mirrorTx, false);
      this.start();
    }
    if (txid && this.scene.txs[txid]) {
      this.mirrorTx = this.scene.txs[txid];
      this.scene.setHover(this.mirrorTx, true);
      this.start();
    }
  }

  updateSearchHighlight(): void {
    if (this.highlightTx && this.highlightTx.txid !== this.searchText && this.scene) {
      this.scene.setHighlight(this.highlightTx, false);
      this.start();
    } else if (this.scene?.txs && this.searchText && this.searchText.length === 64) {
      this.highlightTx = this.scene.txs[this.searchText];
      if (this.highlightTx) {
        this.scene.setHighlight(this.highlightTx, true);
        this.start();
      }
    }
  }

  setHighlightingEnabled(enabled: boolean): void {
    if (this.scene) {
      this.scene.setHighlighting(enabled);
      this.start();
    }
  }

  onTxClick(cssX: number, cssY: number, keyModifier: boolean = false) {
    if (this.scene) {
      const x = cssX * window.devicePixelRatio;
      const y = cssY * window.devicePixelRatio;
      const selected = this.scene.getTxAt({ x, y });
      if (selected && selected.txid) {
        this.txClickEvent.emit({ tx: selected, keyModifier });
      }
    }
  }

  onTxHover(hoverId: string) {
    this.txHoverEvent.emit(hoverId);
  }

  getColorFunction(): ((tx: TxView) => Color) {
    if (this.filterFlags) {
      return this.getFilterColorFunction(this.filterFlags);
    } else if (this.activeFilterFlags) {
      return this.getFilterColorFunction(this.activeFilterFlags);
    } else {
      return this.overrideColors;
    }
  }

  getFilterColorFunction(flags: bigint): ((tx: TxView) => Color) {
    return (tx: TxView) => {
      if ((this.filterMode === 'and' && (tx.bigintFlags & flags) === flags) || (this.filterMode === 'or' && (flags === 0n || (tx.bigintFlags & flags) > 0n))) {
        return defaultColorFunction(tx);
      } else {
        return defaultColorFunction(
          tx,
          unmatchedFeeColors,
          unmatchedAuditFeeColors,
          unmatchedMarginalFeeColors,
          unmatchedAuditColors
        );
      }
    };
  }
}

// WebGL shader attributes
const attribs = {
  offset: { type: 'FLOAT', count: 2, pointer: null, offset: 0 },
  posX: { type: 'FLOAT', count: 4, pointer: null, offset: 0 },
  posY: { type: 'FLOAT', count: 4, pointer: null, offset: 0 },
  posR: { type: 'FLOAT', count: 4, pointer: null, offset: 0 },
  colR: { type: 'FLOAT', count: 4, pointer: null, offset: 0 },
  colG: { type: 'FLOAT', count: 4, pointer: null, offset: 0 },
  colB: { type: 'FLOAT', count: 4, pointer: null, offset: 0 },
  colA: { type: 'FLOAT', count: 4, pointer: null, offset: 0 }
};
// Calculate the number of bytes per vertex based on specified attributes
const stride = Object.values(attribs).reduce((total, attrib) => {
  return total + (attrib.count * 4);
}, 0);
// Calculate vertex attribute offsets
for (let i = 0, offset = 0; i < Object.keys(attribs).length; i++) {
  const attrib = Object.values(attribs)[i];
  attrib.offset = offset;
  offset += (attrib.count * 4);
}

const vertShaderSrc = `
varying lowp vec4 vColor;

// each attribute contains [x: startValue, y: endValue, z: startTime, w: rate]
// shader interpolates between start and end values at the given rate, from the given time

attribute vec2 offset;
attribute vec4 posX;
attribute vec4 posY;
attribute vec4 posR;
attribute vec4 colR;
attribute vec4 colG;
attribute vec4 colB;
attribute vec4 colA;

uniform vec2 screenSize;
uniform float now;

float smootherstep(float x) {
  x = clamp(x, 0.0, 1.0);
  float ix = 1.0 - x;
  x = x * x;
  return x / (x + ix * ix);
}

float interpolateAttribute(vec4 attr) {
  float d = (now - attr.z) * attr.w;
  float delta = smootherstep(d);
  return mix(attr.x, attr.y, delta);
}

void main() {
  vec4 screenTransform = vec4(2.0 / screenSize.x, 2.0 / screenSize.y, -1.0, -1.0);
  // vec4 screenTransform = vec4(1.0 / screenSize.x, 1.0 / screenSize.y, -0.5, -0.5);

  float radius = interpolateAttribute(posR);
  vec2 position = vec2(interpolateAttribute(posX), interpolateAttribute(posY)) + (radius * offset);

  gl_Position = vec4(position * screenTransform.xy + screenTransform.zw, 1.0, 1.0);

  float red = interpolateAttribute(colR);
  float green = interpolateAttribute(colG);
  float blue = interpolateAttribute(colB);
  float alpha = interpolateAttribute(colA);

  vColor = vec4(red, green, blue, alpha);
}
`;

const fragShaderSrc = `
varying lowp vec4 vColor;

void main() {
  gl_FragColor = vColor;
  // premultiply alpha
  gl_FragColor.rgb *= gl_FragColor.a;
}
`;
