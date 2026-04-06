import { allNodeData, archiveProgramIds, formatMetrics, renderMetricBar, getHighlightNodes, getSelectedMetric, selectedProgramId, setSelectedProgramId } from './main.js';
import { getNodeRadius, getNodeColor, selectProgram, scrollAndSelectNodeById } from './graph.js';
import { hideSidebar, sidebarSticky, showSidebarContent, showSidebar, setSidebarSticky } from './sidebar.js';
import { selectListNodeById } from './list.js';

(function() {
    window.addEventListener('DOMContentLoaded', function() {
        const perfDiv = document.getElementById('view-performance');
        if (!perfDiv) return;
        let toggleDiv = document.getElementById('perf-island-toggle');
        if (!toggleDiv) {
            toggleDiv = document.createElement('div');
            toggleDiv.id = 'perf-island-toggle';
            toggleDiv.style = 'display:flex;align-items:center;gap:0.7em;margin-left:3em;';
            toggleDiv.innerHTML = `
            <label class="toggle-switch">
                <input type="checkbox" id="show-islands-toggle">
                <span class="toggle-slider"></span>
            </label>
            <span style="font-weight:500;font-size:1.08em;">Show islands</span>
            `;
            perfDiv.insertBefore(toggleDiv, perfDiv.firstChild);
        }
        function animatePerformanceGraphAttributes() {
            const svg = d3.select('#performance-graph');
            if (svg.empty()) return;
            const g = svg.select('g.zoom-group');
            if (g.empty()) return;
            const metric = getSelectedMetric();
            const highlightFilter = document.getElementById('highlight-select').value;
            const showIslands = document.getElementById('show-islands-toggle')?.checked;
            const nodes = allNodeData;
            const validNodes = nodes.filter(n => n.metrics && typeof n.metrics[metric] === 'number');
            const undefinedNodes = nodes.filter(n => !n.metrics || n.metrics[metric] == null || isNaN(n.metrics[metric]));
            let islands = [];
            if (showIslands) {
                islands = Array.from(new Set(nodes.map(n => n.island))).sort((a,b)=>a-b);
            } else {
                islands = [null];
            }
            const yExtent = d3.extent(nodes, d => d.generation);
            const minGen = 0;
            const maxGen = yExtent[1];
            const margin = {top: 60, right: 40, bottom: 40, left: 60};
            let undefinedBoxWidth = 70;
            const undefinedBoxPad = 54;
            const graphXOffset = undefinedBoxWidth + undefinedBoxPad;
            const width = +svg.attr('width');
            const height = +svg.attr('height');
            const generations = d3.range(minGen, maxGen + 1);
            const xExtent = d3.extent(validNodes, d => d.metrics[metric]);
            const x = d3.scaleLinear()
                .domain([xExtent[0], xExtent[1]]).nice()
                .range([margin.left+graphXOffset, width - margin.right]);
            const {laneMaps: yLayouts} = buildPerformanceYLayouts(
                nodes,
                generations,
                islands,
                showIslands,
                margin,
                node => getPerformanceNodeX(node, metric, x, margin.left + undefinedBoxWidth / 2)
            );
            const highlightNodes = getHighlightNodes(nodes, highlightFilter, metric);
            const highlightIds = new Set(highlightNodes.map(n => n.id));
            // Animate valid nodes
            g.selectAll('circle')
                .filter(function(d) { return validNodes.includes(d); })
                .transition().duration(400)
                .attr('cx', d => getPerformanceNodeX(d, metric, x, x.range()[0] - 100))
                .attr('cy', d => getResolvedNodeY(d, yLayouts, showIslands))
                .attr('r', d => getPerfNodeRadius(d))
                .attr('fill', d => getNodeColor(d))
                .attr('stroke', d => selectedProgramId === d.id ? 'red' : (highlightIds.has(d.id) ? '#2196f3' : '#333'))
                .attr('stroke-width', d => selectedProgramId === d.id ? 3 : 1.5)
                .attr('opacity', 0.85)
                .on('end', null)
                .selection()
                .each(function(d) {
                    d3.select(this)
                        .classed('node-highlighted', highlightIds.has(d.id))
                        .classed('node-selected', selectedProgramId === d.id);
                });
            // Animate undefined nodes (NaN box)
            g.selectAll('circle')
                .filter(function(d) { return undefinedNodes.includes(d); })
                .transition().duration(400)
                .attr('cx', d => getPerformanceNodeX(d, metric, x, margin.left + undefinedBoxWidth / 2))
                .attr('cy', d => getResolvedNodeY(d, yLayouts, showIslands))
                .attr('r', d => getPerfNodeRadius(d))
                .attr('fill', d => getNodeColor(d))
                .attr('stroke', d => selectedProgramId === d.id ? 'red' : '#333')
                .attr('stroke-width', d => selectedProgramId === d.id ? 3 : 1.5)
                .attr('opacity', 0.85)
                .on('end', null)
                .selection()
                .each(function(d) {
                    d3.select(this)
                        .classed('node-selected', selectedProgramId === d.id);
                });
            // Animate edges
            const nodeById = Object.fromEntries(nodes.map(n => [n.id, n]));
            const edges = nodes.filter(n => n.parent_id && nodeById[n.parent_id]).map(n => {
                return {
                    source: nodeById[n.parent_id],
                    target: n
                };
            });
            g.selectAll('line.performance-edge')
                .data(edges, d => d.target.id)
                .transition().duration(400)
                .attr('x1', d => getPerformanceNodeX(d.source, metric, x, margin.left + undefinedBoxWidth / 2))
                .attr('y1', d => getResolvedNodeY(d.source, yLayouts, showIslands))
                .attr('x2', d => getPerformanceNodeX(d.target, metric, x, margin.left + undefinedBoxWidth / 2))
                .attr('y2', d => getResolvedNodeY(d.target, yLayouts, showIslands))
                .attr('stroke', d => (selectedProgramId && (d.source.id === selectedProgramId || d.target.id === selectedProgramId)) ? 'red' : '#888')
                .attr('stroke-width', d => (selectedProgramId && (d.source.id === selectedProgramId || d.target.id === selectedProgramId)) ? 3 : 1.5)
                .attr('opacity', 0.5);
        }
        const metricSelect = document.getElementById('metric-select');
        metricSelect.addEventListener('change', function() {
            updatePerformanceGraph(allNodeData);
            setTimeout(updateEdgeHighlighting, 0); // ensure edges update after node positions change
        });
        const highlightSelect = document.getElementById('highlight-select');
        highlightSelect.addEventListener('change', function() {
            animatePerformanceGraphAttributes();
            setTimeout(updateEdgeHighlighting, 0); // ensure edges update after animation
        });
        document.getElementById('tab-performance').addEventListener('click', function() {
            if (typeof allNodeData !== 'undefined' && allNodeData.length) {
                updatePerformanceGraph(allNodeData, {autoZoom: true});
                setTimeout(() => { zoomPerformanceGraphToFit(); }, 0);
            }
        });
        // Show islands yes/no toggle event
        document.getElementById('show-islands-toggle').addEventListener('change', function() {
            updatePerformanceGraph(allNodeData);
        });
        // Responsive resize
        window.addEventListener('resize', function() {
            if (typeof allNodeData !== 'undefined' && allNodeData.length && perfDiv.style.display !== 'none') {
                updatePerformanceGraph(allNodeData);
            }
        });
        window.updatePerformanceGraph = updatePerformanceGraph;

        // Initial render
        if (typeof allNodeData !== 'undefined' && allNodeData.length) {
            updatePerformanceGraph(allNodeData);
            // Zoom to fit after initial render
            setTimeout(() => {
                zoomPerformanceGraphToFit();
            }, 0);
        }
    });
})();

// Recenter Button Overlay
function showRecenterButton(onClick) {
    let btn = document.getElementById('performance-recenter-btn');
    if (!btn) {
        btn = document.createElement('button');
        btn.id = 'performance-recenter-btn';
        btn.textContent = 'Recenter';
        btn.style.position = 'absolute';
        btn.style.left = '50%';
        btn.style.top = '50%';
        btn.style.transform = 'translate(-50%, -50%)';
        btn.style.zIndex = 1000;
        btn.style.fontSize = '2em';
        btn.style.padding = '0.5em 1.5em';
        btn.style.background = '#fff';
        btn.style.border = '2px solid #2196f3';
        btn.style.borderRadius = '12px';
        btn.style.boxShadow = '0 2px 16px #0002';
        btn.style.cursor = 'pointer';
        btn.style.display = 'block';
        document.getElementById('view-performance').appendChild(btn);
    }
    btn.style.display = 'block';
    btn.onclick = function() {
        btn.style.display = 'none';
        if (typeof onClick === 'function') onClick();
    };
}
function hideRecenterButton() {
    const btn = document.getElementById('performance-recenter-btn');
    if (btn) btn.style.display = 'none';
}

// Select a node by ID and update graph and sidebar
export function selectPerformanceNodeById(id, opts = {}) {
    setSelectedProgramId(id);
    setSidebarSticky(true);
    // Dispatch event for list view sync
    window.dispatchEvent(new CustomEvent('node-selected', { detail: { id } }));
    if (typeof allNodeData !== 'undefined' && allNodeData.length) {
        updatePerformanceGraph(allNodeData, opts);
        const node = allNodeData.find(n => n.id == id);
        if (node) showSidebarContent(node, false);
    }
}

export function centerAndHighlightNodeInPerformanceGraph(nodeId) {
    if (!g || !svg) return;
    // Ensure zoomBehavior is available and is a function
    if (!zoomBehavior || typeof zoomBehavior !== 'function') {
        zoomBehavior = d3.zoom()
            .scaleExtent([0.2, 10])
            .on('zoom', function(event) {
                g.attr('transform', event.transform);
                lastTransform = event.transform;
            });
        svg.call(zoomBehavior);
    }
    // Try both valid and NaN nodes
    let nodeSel = g.selectAll('circle.performance-node').filter(d => d.id == nodeId);
    if (nodeSel.empty()) {
        nodeSel = g.selectAll('circle.performance-nan').filter(d => d.id == nodeId);
    }
    if (!nodeSel.empty()) {
        const node = nodeSel.node();
        const bbox = node.getBBox();
        const graphW = svg.attr('width');
        const graphH = svg.attr('height');
        const scale = Math.min(graphW / (bbox.width * 6), graphH / (bbox.height * 6), 1.5);
        const tx = graphW/2 - scale * (bbox.x + bbox.width/2);
        const ty = graphH/2 - scale * (bbox.y + bbox.height/2);
        const t = d3.zoomIdentity.translate(tx, ty).scale(scale);
        // Use the correct D3 v7 API for programmatic zoom
        svg.transition().duration(400).call(zoomBehavior.transform, t);
        // Yellow shadow highlight
        nodeSel.each(function() {
            const el = d3.select(this);
            el.classed('node-locator-highlight', true)
                .style('filter', 'drop-shadow(0 0 16px 8px #FFD600)');
            el.transition().duration(350).style('filter', 'drop-shadow(0 0 24px 16px #FFD600)')
                .transition().duration(650).style('filter', null)
                .on('end', function() { el.classed('node-locator-highlight', false); });
        });
    }
}

let svg = null;
let g = null;
let zoomBehavior = null;
let lastTransform = null;
const PERFORMANCE_GENERATION_SPACING = 90;
const PERFORMANCE_MIN_LANE_HEIGHT = 28;
const PERFORMANCE_LANE_GAP = 8;
const PERFORMANCE_ISLAND_GAP = 20;
const PERFORMANCE_NODE_PADDING = 3;
const PERFORMANCE_DODGE_ATTEMPTS = 120;

function getPerfNodeRadius(node) {
    return getNodeRadius(node) / 2;
}

function getRequiredLaneHeight(nodes, xFn) {
    if (!nodes.length) {
        return PERFORMANCE_MIN_LANE_HEIGHT;
    }
    if (typeof xFn !== 'function') {
        const totalDiameter = nodes.reduce((sum, node) => sum + getPerfNodeRadius(node) * 2, 0);
        const totalPadding = PERFORMANCE_NODE_PADDING * Math.max(nodes.length + 1, 2);
        return Math.max(PERFORMANCE_MIN_LANE_HEIGHT, Math.ceil(totalDiameter + totalPadding));
    }

    const positionedNodes = nodes
        .map(node => ({
            x: xFn(node),
            radius: getPerfNodeRadius(node)
        }))
        .filter(node => Number.isFinite(node.x))
        .sort((a, b) => a.x - b.x);

    if (!positionedNodes.length) {
        return PERFORMANCE_MIN_LANE_HEIGHT;
    }

    const active = [];
    let maxOverlapDepth = 1;
    let maxActiveRadius = 0;

    positionedNodes.forEach(node => {
        const leftEdge = node.x - node.radius - PERFORMANCE_NODE_PADDING;
        for (let i = active.length - 1; i >= 0; i--) {
            if (active[i].rightEdge < leftEdge) {
                active.splice(i, 1);
            }
        }

        active.push({
            rightEdge: node.x + node.radius + PERFORMANCE_NODE_PADDING,
            radius: node.radius
        });

        const activeDepth = active.length;
        const activeRadius = active.reduce((maxRadius, activeNode) => Math.max(maxRadius, activeNode.radius), 0);
        maxOverlapDepth = Math.max(maxOverlapDepth, activeDepth);
        maxActiveRadius = Math.max(maxActiveRadius, activeRadius);
    });

    const requiredHeight =
        maxOverlapDepth * (maxActiveRadius * 2 + PERFORMANCE_NODE_PADDING) +
        PERFORMANCE_NODE_PADDING * 2;
    return Math.max(PERFORMANCE_MIN_LANE_HEIGHT, Math.ceil(requiredHeight));
}

function buildPerformanceYLayouts(nodes, generations, islands, showIslands, margin, xFn) {
    const groupedNodes = new Map();
    nodes.forEach(node => {
        const islandKey = showIslands ? node.island : null;
        const key = `${node.generation}|${islandKey}`;
        if (!groupedNodes.has(key)) {
            groupedNodes.set(key, []);
        }
        groupedNodes.get(key).push(node);
    });

    const laneMaps = {};
    const islandExtents = {};
    let cursorY = margin.top;

    islands.forEach((island, islandIndex) => {
        const islandKey = showIslands ? island : null;
        const laneMap = new Map();
        const islandTop = cursorY;

        generations.forEach((generation, generationIndex) => {
            const laneNodes = groupedNodes.get(`${generation}|${islandKey}`) || [];
            const laneHeight = getRequiredLaneHeight(laneNodes, xFn);
            const lane = {
                top: cursorY,
                height: laneHeight,
                bottom: cursorY + laneHeight,
                center: cursorY + laneHeight / 2
            };
            laneMap.set(generation, lane);
            cursorY = lane.bottom;
            if (generationIndex < generations.length - 1) {
                cursorY += PERFORMANCE_LANE_GAP;
            }
        });

        islandExtents[island] = {
            top: islandTop,
            bottom: cursorY,
            height: cursorY - islandTop,
            center: islandTop + (cursorY - islandTop) / 2
        };
        laneMaps[island] = laneMap;

        if (showIslands && islandIndex < islands.length - 1) {
            cursorY += PERFORMANCE_ISLAND_GAP;
        }
    });

    return {
        laneMaps,
        islandExtents,
        totalHeight: cursorY + margin.bottom
    };
}

function getGenerationLane(node, yLayouts, showIslands) {
    return yLayouts[showIslands ? node.island : null]?.get(node.generation);
}

function getPerformanceBaseY(node, yLayouts, showIslands) {
    return getGenerationLane(node, yLayouts, showIslands)?.center ?? 0;
}

function getResolvedNodeY(node, yLayouts, showIslands) {
    return typeof node._adjustedY === 'number'
        ? node._adjustedY
        : getPerformanceBaseY(node, yLayouts, showIslands);
}

function getPerformanceNodeX(node, metric, x, fallbackX) {
    if (node.metrics && typeof node.metrics[metric] === 'number') {
        return x(node.metrics[metric]);
    }
    if (typeof node._nanX === 'number') {
        return node._nanX;
    }
    return fallbackX;
}

function getPerformanceGroupKey(node, showIslands) {
    return `${node.generation}|${showIslands ? node.island : 'main'}`;
}

function resolveNodeOverlaps(nodes, xFn, yLayouts, showIslands) {
    const groups = new Map();
    nodes.forEach(node => {
        const key = getPerformanceGroupKey(node, showIslands);
        if (!groups.has(key)) {
            const lane = getGenerationLane(node, yLayouts, showIslands);
            groups.set(key, {
                baseY: getPerformanceBaseY(node, yLayouts, showIslands),
                bandTop: lane?.top ?? 0,
                bandBottom: lane?.bottom ?? 0,
                nodes: []
            });
        }
        groups.get(key).nodes.push(node);
    });

    groups.forEach(group => {
        const placed = [];
        const sortedNodes = [...group.nodes].sort((a, b) => {
            const ax = xFn(a);
            const bx = xFn(b);
            if (ax === bx) {
                return getPerfNodeRadius(b) - getPerfNodeRadius(a);
            }
            return ax - bx;
        });

        sortedNodes.forEach(node => {
            const radius = getPerfNodeRadius(node);
            const cx = xFn(node);
            const step = Math.max(radius + PERFORMANCE_NODE_PADDING, 8);
            const baseY = group.baseY;
            const minY = group.bandTop + radius;
            const maxY = group.bandBottom - radius;
            let candidateY = baseY;

            if (Number.isFinite(cx)) {
                for (let attempt = 0; attempt < PERFORMANCE_DODGE_ATTEMPTS; attempt++) {
                    if (attempt === 0) {
                        candidateY = baseY;
                    } else {
                        const level = Math.ceil(attempt / 2);
                        const direction = attempt % 2 === 1 ? -1 : 1;
                        candidateY = baseY + direction * level * step;
                    }

                    if (minY <= maxY) {
                        candidateY = Math.max(minY, Math.min(maxY, candidateY));
                    } else {
                        candidateY = baseY;
                    }

                    const collides = placed.some(placedNode => {
                        const dx = cx - placedNode.cx;
                        const dy = candidateY - placedNode.cy;
                        const minDistance = radius + placedNode.radius + PERFORMANCE_NODE_PADDING;
                        return (dx * dx + dy * dy) < (minDistance * minDistance);
                    });

                    if (!collides) {
                        break;
                    }
                }
            }

            node._adjustedY = candidateY;
            placed.push({cx, cy: candidateY, radius});
        });
    });
}

function autoZoomPerformanceGraph(nodes, x, yScales, islands, graphHeight, margin, undefinedBoxWidth, width, svg, g) {
    // Compute bounding box for all nodes (including NaN box)
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    // Valid nodes
    nodes.forEach(n => {
        let cx, cy;
        const showIslands = document.getElementById('show-islands-toggle')?.checked;
        cx = getPerformanceNodeX(n, getSelectedMetric(), x, margin.left + undefinedBoxWidth / 2);
        cy = getResolvedNodeY(n, yScales, showIslands);
        if (typeof cx === 'number' && typeof cy === 'number') {
            minX = Math.min(minX, cx);
            maxX = Math.max(maxX, cx);
            minY = Math.min(minY, cy);
            maxY = Math.max(maxY, cy);
        }
    });
    // Include NaN box
    minX = Math.min(minX, margin.left);
    // Add some padding
    const padX = 60, padY = 60;
    minX -= padX; maxX += padX; minY -= padY; maxY += padY;
    const svgW = +svg.attr('width');
    const svgH = +svg.attr('height');
    const scale = Math.min(svgW / (maxX - minX), svgH / (maxY - minY), 1.5);
    const tx = svgW/2 - scale * (minX + (maxX-minX)/2);
    const ty = svgH/2 - scale * (minY + (maxY-minY)/2);
    const t = d3.zoomIdentity.translate(tx, ty).scale(scale);
    svg.transition().duration(500).call(zoomBehavior.transform, t);
}

function updatePerformanceGraph(nodes, options = {}) {
    // Get or create SVG
    if (!svg) {
        svg = d3.select('#performance-graph');
        if (svg.empty()) {
            svg = d3.select('#view-performance')
                .append('svg')
                .attr('id', 'performance-graph')
                .style('display', 'block');
        }
    }
    // Get or create group
    g = svg.select('g.zoom-group');
    if (g.empty()) {
        g = svg.append('g').attr('class', 'zoom-group');
    }
    // Setup zoom behavior only once
    if (!zoomBehavior) {
        zoomBehavior = d3.zoom()
            .scaleExtent([0.2, 10])
            .on('zoom', function(event) {
                g.attr('transform', event.transform);
                lastTransform = event.transform;
                // Check if all content is out of view
                setTimeout(() => {
                    try {
                        const svgRect = svg.node().getBoundingClientRect();
                        const allCircles = g.selectAll('circle').nodes();
                        if (allCircles.length === 0) { hideRecenterButton(); return; }
                        let anyVisible = false;
                        for (const c of allCircles) {
                            const bbox = c.getBoundingClientRect();
                            if (
                                bbox.right > svgRect.left &&
                                bbox.left < svgRect.right &&
                                bbox.bottom > svgRect.top &&
                                bbox.top < svgRect.bottom
                            ) {
                                anyVisible = true;
                                break;
                            }
                        }
                        if (!anyVisible) {
                            showRecenterButton(() => {
                                // Reset zoom/pan
                                svg.transition().duration(400).call(zoomBehavior.transform, d3.zoomIdentity);
                            });
                        } else {
                            hideRecenterButton();
                        }
                    } catch {}
                }, 0);
            });
        svg.call(zoomBehavior);
    }
    // Reapply last transform after update
    if (lastTransform) {
        svg.call(zoomBehavior.transform, lastTransform);
    }
    // Add SVG background click handler for unselect
    svg.on('click', function(event) {
        if (event.target === svg.node()) {
            setSelectedProgramId(null);
            setSidebarSticky(false);
            hideSidebar();
            // Remove selection from all nodes
            g.selectAll('circle.performance-node, circle.performance-nan')
                .classed('node-selected', false)
                .attr('stroke', function(d) {
                    // Use highlight color if highlighted, else default
                    const highlightFilter = document.getElementById('highlight-select').value;
                    const highlightNodes = getHighlightNodes(nodes, highlightFilter, getSelectedMetric());
                    const highlightIds = new Set(highlightNodes.map(n => n.id));
                    return highlightIds.has(d.id) ? '#2196f3' : '#333';
                })
                .attr('stroke-width', 1.5);
            selectListNodeById(null);
            setTimeout(updateEdgeHighlighting, 0); // ensure edges update after selectedProgramId is null
        }
    });
    // Sizing
    const sidebarEl = document.getElementById('sidebar');
    const padding = 32;
    const windowWidth = window.innerWidth;
    const windowHeight = window.innerHeight;
    const toolbarHeight = document.getElementById('toolbar').offsetHeight;
    const sidebarWidth = sidebarEl.offsetWidth || 400;
    const width = Math.max(windowWidth - sidebarWidth - padding, 400);
    const metric = getSelectedMetric();
    const validNodes = nodes.filter(n => n.metrics && typeof n.metrics[metric] === 'number');
    const undefinedNodes = nodes.filter(n => !n.metrics || n.metrics[metric] == null || isNaN(n.metrics[metric]));
    const showIslands = document.getElementById('show-islands-toggle')?.checked;
    let islands = [];
    if (showIslands) {
        islands = Array.from(new Set(nodes.map(n => n.island))).sort((a,b)=>a-b);
    } else {
        islands = [null];
    }
    const yExtent = d3.extent(nodes, d => d.generation);
    const minGen = 0;
    const maxGen = yExtent[1];
    const margin = {top: 60, right: 40, bottom: 40, left: 60};
    let undefinedBoxWidth = 70;
    const undefinedBoxPad = 54;
    const generations = d3.range(minGen, maxGen + 1);
    const graphXOffset = undefinedBoxWidth + undefinedBoxPad;
    const xExtent = d3.extent(validNodes, d => d.metrics[metric]);
    const x = d3.scaleLinear()
        .domain([xExtent[0], xExtent[1]]).nice()
        .range([margin.left+graphXOffset, width - margin.right]);
    const {laneMaps: yLayouts, islandExtents, totalHeight} = buildPerformanceYLayouts(
        nodes,
        generations,
        islands,
        showIslands,
        margin,
        node => getPerformanceNodeX(node, metric, x, margin.left + undefinedBoxWidth / 2)
    );
    const lastIsland = islands[islands.length - 1];
    const graphBottom = islandExtents[lastIsland]?.bottom ?? margin.top;
    const graphHeight = graphBottom - margin.top + margin.bottom;
    const totalGraphHeight = Math.max(graphHeight, totalHeight);
    const svgHeight = Math.max(windowHeight - toolbarHeight - 24, totalGraphHeight);
    svg.attr('width', width).attr('height', svgHeight);
    // Remove old axes/labels
    g.selectAll('.axis, .axis-label, .island-label, .nan-label, .nan-box, .gen-box, .gen-box-label').remove();
    islands.forEach((island) => {
        generations.forEach(gen => {
            const lane = yLayouts[island]?.get(gen);
            const bandY = lane?.top ?? margin.top;
            const bandHeight = lane?.height ?? PERFORMANCE_MIN_LANE_HEIGHT;
            g.insert('rect', ':first-child')
                .attr('class', 'gen-box')
                .attr('x', margin.left + graphXOffset)
                .attr('y', bandY)
                .attr('width', width - (margin.left + graphXOffset) - margin.right)
                .attr('height', bandHeight)
                .attr('fill', gen % 2 === 0 ? '#fafafa' : '#ffffff')
                .attr('stroke', '#ddd')
                .attr('stroke-width', 1)
                .attr('rx', 6)
                .attr('pointer-events', 'none');
            g.append('text')
                .attr('class', 'gen-box-label')
                .attr('x', margin.left + graphXOffset - 8)
                .attr('y', bandY + bandHeight / 2)
                .attr('text-anchor', 'end')
                .attr('dominant-baseline', 'middle')
                .attr('font-size', '0.9em')
                .attr('fill', '#666')
                .attr('pointer-events', 'none')
                .text(`Gen ${gen}`);
        });
        // Y axis label (always at start of main graph)
        g.append('text')
            .attr('class', 'axis-label')
            .attr('transform', `rotate(-90)`) // vertical
            .attr('y', margin.left + graphXOffset + 8)
            .attr('x', -(islandExtents[island]?.center ?? (margin.top + graphHeight / 2)))
            .attr('dy', '-2.2em')
            .attr('text-anchor', 'middle')
            .attr('font-size', '1em')
            .attr('fill', '#888')
            .text('Generation');
        // Island label
        if (showIslands) {
            g.append('text')
                .attr('class', 'island-label')
                .attr('x', (width + undefinedBoxWidth) / 2)
                .attr('y', (islandExtents[island]?.top ?? margin.top) + 38)
                .attr('text-anchor', 'middle')
                .attr('font-size', '2.1em')
                .attr('font-weight', 700)
                .attr('fill', '#444')
                .attr('pointer-events', 'none')
                .text(`Island ${island}`);
        }
    });
    // X axis
    // Remove old x axis and label only
    g.selectAll('.x-axis, .x-axis-label').remove();
    // Add x axis group
    g.append('g')
        .attr('class', 'axis x-axis')
        .attr('transform', `translate(0,${margin.top})`)
        .call(d3.axisTop(x))
        .selectAll('text')
        .attr('font-size', '1.1em');
    // Add x axis label
    g.append('text')
        .attr('class', 'x-axis-label')
        .attr('x', (width + undefinedBoxWidth) / 2)
        .attr('y', margin.top - 32)
        .attr('fill', '#666')
        .attr('text-anchor', 'middle')
        .attr('font-size', '1.4em')
        .attr('font-weight', 500)
        .text(metric);
    // NaN box
    if (undefinedNodes.length) {
        // Group NaN nodes by (generation, island)
        const nanGroups = {};
        undefinedNodes.forEach(n => {
            const key = `${n.generation}|${showIslands ? n.island : ''}`;
            if (!nanGroups[key]) nanGroups[key] = [];
            nanGroups[key].push(n);
        });
        // Find max group size
        const maxGroupSize = Math.max(...Object.values(nanGroups).map(g => g.length));
        // Box width should be based on the full intended spread, not the reduced spread
        const spreadWidth = Math.max(38, 24 * maxGroupSize);
        undefinedBoxWidth = spreadWidth/2 + 32; // 16px padding on each side
        // Add a fixed offset so the NaN box is further left of the main graph
        const nanBoxGap = 64; // px gap between NaN box and main graph
        const nanBoxRight = margin.left + graphXOffset - nanBoxGap;
        const nanBoxLeft = nanBoxRight - undefinedBoxWidth;
        const boxTop = margin.top;
        const boxBottom = graphBottom;
        g.append('text')
            .attr('class', 'nan-label')
            .attr('x', nanBoxLeft + undefinedBoxWidth/2)
            .attr('y', boxTop - 10)
            .attr('text-anchor', 'middle')
            .attr('font-size', '0.92em')
            .attr('fill', '#888')
            .text('NaN');
        g.append('rect')
            .attr('class', 'nan-box')
            .attr('x', nanBoxLeft)
            .attr('y', boxTop)
            .attr('width', undefinedBoxWidth)
            .attr('height', boxBottom - boxTop)
            .attr('fill', 'none')
            .attr('stroke', '#bbb')
            .attr('stroke-width', 1.5)
            .attr('rx', 12);
        // Assign x offset for each NaN node (spread only in the center half of the box)
        undefinedNodes.forEach(n => {
            const key = `${n.generation}|${showIslands ? n.island : ''}`;
            const group = nanGroups[key];
            if (!group) return;
            if (group.length === 1) {
                n._nanX = nanBoxLeft + undefinedBoxWidth/2;
            } else {
                const idx = group.indexOf(n);
                const innerSpread = spreadWidth / 2; // only use half the box for node spread
                const innerStart = nanBoxLeft + (undefinedBoxWidth - innerSpread) / 2;
                n._nanX = innerStart + innerSpread * (idx + 0.5) / group.length;
            }
        });
    }
    // Data join for edges
    const nodeById = Object.fromEntries(nodes.map(n => [n.id, n]));
    const edges = nodes.filter(n => n.parent_id && nodeById[n.parent_id]).map(n => ({ source: nodeById[n.parent_id], target: n }));
    // Remove all old edges before re-adding (fixes missing/incorrect edges after metric change)
    g.selectAll('line.performance-edge').remove();
    // Helper to get x/y for a node (handles NaN and valid nodes)
    function getNodeXY(node, x, yLayouts, showIslands, metric) {
        // Returns [x, y] for a node, handling both valid and NaN nodes
        if (!node) return [null, null];
        const y = getResolvedNodeY(node, yLayouts, showIslands);
        return [getPerformanceNodeX(node, metric, x, x.range()[0] - 100), y];
    }
    resolveNodeOverlaps(nodes, node => getPerformanceNodeX(node, metric, x, x.range()[0] - 100), yLayouts, showIslands);
    g.selectAll('line.performance-edge')
        .data(edges, d => d.target.id)
        .enter()
        .append('line')
        .attr('class', 'performance-edge')
        .attr('stroke', '#888')
        .attr('stroke-width', 1.5)
        .attr('opacity', 0.5)
        .attr('x1', d => getNodeXY(d.source, x, yLayouts, showIslands, metric)[0])
        .attr('y1', d => getNodeXY(d.source, x, yLayouts, showIslands, metric)[1])
        .attr('x2', d => getNodeXY(d.target, x, yLayouts, showIslands, metric)[0])
        .attr('y2', d => getNodeXY(d.target, x, yLayouts, showIslands, metric)[1])
        .attr('stroke', d => {
            if (selectedProgramId && (d.source.id === selectedProgramId || d.target.id === selectedProgramId)) {
                return 'red';
            }
            return '#888';
        })
        .attr('stroke-width', d => (selectedProgramId && (d.source.id === selectedProgramId || d.target.id === selectedProgramId)) ? 3 : 1.5)
        .attr('opacity', d => (selectedProgramId && (d.source.id === selectedProgramId || d.target.id === selectedProgramId)) ? 0.9 : 0.5);
    // Ensure edge highlighting updates after node selection
    function updateEdgeHighlighting() {
        g.selectAll('line.performance-edge')
            .attr('stroke', d => (selectedProgramId && (d.source.id === selectedProgramId || d.target.id === selectedProgramId)) ? 'red' : '#888')
            .attr('stroke-width', d => (selectedProgramId && (d.source.id === selectedProgramId || d.target.id === selectedProgramId)) ? 3 : 1.5)
            .attr('opacity', d => (selectedProgramId && (d.source.id === selectedProgramId || d.target.id === selectedProgramId)) ? 0.9 : 0.5);
    }
    updateEdgeHighlighting();

    // Data join for nodes
    const highlightFilter = document.getElementById('highlight-select').value;
    const highlightNodes = getHighlightNodes(nodes, highlightFilter, metric);
    const highlightIds = new Set(highlightNodes.map(n => n.id));
    const nodeSel = g.selectAll('circle.performance-node')
        .data(validNodes, d => d.id);
    nodeSel.enter()
        .append('circle')
        .attr('class', 'performance-node')
        .attr('cx', d => getPerformanceNodeX(d, metric, x, x.range()[0] - 100))
        .attr('cy', d => getResolvedNodeY(d, yLayouts, showIslands))
        .attr('r', d => getPerfNodeRadius(d))
        .attr('fill', d => getNodeColor(d))
        .attr('stroke', d => selectedProgramId === d.id ? 'red' : (highlightIds.has(d.id) ? '#2196f3' : '#333'))
        .attr('stroke-width', d => selectedProgramId === d.id ? 3 : 1.5)
        .attr('opacity', 0.85)
        .on('mouseover', function(event, d) {
            if (!sidebarSticky && (!selectedProgramId || selectedProgramId !== d.id)) {
                showSidebarContent(d, true);
                showSidebar();
            }
            d3.select(this)
                .classed('node-hovered', true)
                .attr('stroke', '#FFD600').attr('stroke-width', 4);
        })
        .on('mouseout', function(event, d) {
            d3.select(this)
                .classed('node-hovered', false)
                .attr('stroke', selectedProgramId === d.id ? 'red' : (highlightIds.has(d.id) ? '#2196f3' : '#333'))
                .attr('stroke-width', selectedProgramId === d.id ? 3 : 1.5);
            if (!selectedProgramId) {
                hideSidebar();
            }
        })
        .on('click', function(event, d) {
            event.preventDefault();
            setSelectedProgramId(d.id);
            window._lastSelectedNodeData = d;
            setSidebarSticky(true);
            selectListNodeById(d.id);
            g.selectAll('circle.performance-node').classed('node-hovered', false).classed('node-selected', false)
                .attr('stroke', function(nd) {
                    return selectedProgramId === nd.id ? 'red' : (highlightIds.has(nd.id) ? '#2196f3' : '#333');
                })
                .attr('stroke-width', function(nd) {
                    return selectedProgramId === nd.id ? 3 : 1.5;
                });
            d3.select(this).classed('node-selected', true);
            showSidebarContent(d, false);
            showSidebar();
            selectProgram(selectedProgramId);
            updateEdgeHighlighting();
        })
        .merge(nodeSel)
        .transition().duration(500)
        .attr('cx', d => getPerformanceNodeX(d, metric, x, x.range()[0] - 100))
        .attr('cy', d => getResolvedNodeY(d, yLayouts, showIslands))
        .attr('r', d => getPerfNodeRadius(d))
        .attr('fill', d => getNodeColor(d))
        .attr('stroke', d => selectedProgramId === d.id ? 'red' : (highlightIds.has(d.id) ? '#2196f3' : '#333'))
        .attr('stroke-width', d => selectedProgramId === d.id ? 3 : 1.5)
        .attr('opacity', 0.85)
        .on('end', null)
        .selection()
        .each(function(d) {
            d3.select(this)
                .classed('node-highlighted', highlightIds.has(d.id))
                .classed('node-selected', selectedProgramId === d.id);
        });
    nodeSel.exit().transition().duration(300).attr('opacity', 0).remove();
    // Data join for NaN nodes
    const nanSel = g.selectAll('circle.performance-nan')
        .data(undefinedNodes, d => d.id);
    nanSel.enter()
        .append('circle')
        .attr('class', 'performance-nan')
        .attr('cx', d => getPerformanceNodeX(d, metric, x, margin.left + undefinedBoxWidth / 2))
        .attr('cy', d => getResolvedNodeY(d, yLayouts, showIslands))
        .attr('r', d => getPerfNodeRadius(d))
        .attr('fill', d => getNodeColor(d))
        .attr('stroke', d => selectedProgramId === d.id ? 'red' : '#333')
        .attr('stroke-width', d => selectedProgramId === d.id ? 3 : 1.5)
        .attr('opacity', 0.85)
        .on('mouseover', function(event, d) {
            if (!sidebarSticky && (!selectedProgramId || selectedProgramId !== d.id)) {
                showSidebarContent(d, true);
                showSidebar();
            }
            d3.select(this)
                .classed('node-hovered', true)
                .attr('stroke', '#FFD600').attr('stroke-width', 4);
        })
        .on('mouseout', function(event, d) {
            d3.select(this)
                .classed('node-hovered', false)
                .attr('stroke', selectedProgramId === d.id ? 'red' : '#333')
                .attr('stroke-width', selectedProgramId === d.id ? 3 : 1.5);
            if (!selectedProgramId) {
                hideSidebar();
            }
        })
        .on('click', function(event, d) {
            event.preventDefault();
            setSelectedProgramId(d.id);
            window._lastSelectedNodeData = d;
            setSidebarSticky(true);
            selectListNodeById(d.id);
            g.selectAll('circle.performance-nan').classed('node-hovered', false).classed('node-selected', false)
                .attr('stroke', function(nd) {
                    return selectedProgramId === nd.id ? 'red' : '#333';
                })
                .attr('stroke-width', function(nd) {
                    return selectedProgramId === nd.id ? 3 : 1.5;
                });
            d3.select(this).classed('node-selected', true);
            showSidebarContent(d, false);
            showSidebar();
            selectProgram(selectedProgramId);
            updateEdgeHighlighting();
        })
        .merge(nanSel)
        .transition().duration(500)
        .attr('cx', d => getPerformanceNodeX(d, metric, x, margin.left + undefinedBoxWidth / 2))
        .attr('cy', d => getResolvedNodeY(d, yLayouts, showIslands))
        .attr('r', d => getPerfNodeRadius(d))
        .attr('fill', d => getNodeColor(d))
        .attr('stroke', d => selectedProgramId === d.id ? 'red' : '#333')
        .attr('stroke-width', d => selectedProgramId === d.id ? 3 : 1.5)
        .attr('opacity', 0.85)
        .on('end', null)
        .selection()
        .each(function(d) {
            d3.select(this)
                .classed('node-selected', selectedProgramId === d.id);
        });
    nanSel.exit().transition().duration(300).attr('opacity', 0).remove();
    // Auto-zoom to fit on initial render or when requested
    if (options.autoZoom || (!lastTransform && nodes.length)) {
        autoZoomPerformanceGraph(nodes, x, yLayouts, islands, graphHeight, margin, undefinedBoxWidth, width, svg, g);
    }
}

// Zoom-to-fit helper
function zoomPerformanceGraphToFit() {
    if (!svg || !g) return;
    // Get all node positions (valid and NaN)
    const nodeCircles = g.selectAll('circle.performance-node, circle.performance-nan').nodes();
    if (!nodeCircles.length) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    nodeCircles.forEach(node => {
        const bbox = node.getBBox();
        minX = Math.min(minX, bbox.x);
        minY = Math.min(minY, bbox.y);
        maxX = Math.max(maxX, bbox.x + bbox.width);
        maxY = Math.max(maxY, bbox.y + bbox.height);
    });
    // Also include the NaN box if present
    const nanBox = g.select('rect.nan-box').node();
    if (nanBox) {
        const bbox = nanBox.getBBox();
        minX = Math.min(minX, bbox.x);
        minY = Math.min(minY, bbox.y);
        maxX = Math.max(maxX, bbox.x + bbox.width);
        maxY = Math.max(maxY, bbox.y + bbox.height);
    }
    // Add some padding
    const pad = 32;
    minX -= pad; minY -= pad; maxX += pad; maxY += pad;
    const graphW = svg.attr('width');
    const graphH = svg.attr('height');
    // Bias the center to the left so the left edge is always visible
    // Instead of centering on the middle, center at 35% from the left
    const centerFrac = 0.35;
    const centerX = minX + (maxX - minX) * centerFrac;
    const centerY = minY + (maxY - minY) / 2;
    const scale = Math.min(graphW / (maxX - minX), graphH / (maxY - minY), 1.5);
    const tx = graphW/2 - scale * centerX;
    const ty = graphH/2 - scale * centerY;
    const t = d3.zoomIdentity.translate(tx, ty).scale(scale);
    svg.transition().duration(400).call(zoomBehavior.transform, t);
    lastTransform = t;
}
