import { allNodeData, getHighlightNodes, selectedProgramId, setSelectedProgramId } from './main.js';
import { getNodeColor, selectProgram } from './graph.js';
import { hideSidebar, sidebarSticky, showSidebarContent, showSidebar, setSidebarSticky } from './sidebar.js';
import { selectListNodeById } from './list.js';

const DEFAULT_DIM_X = 'avg_p95_latency_ratio';
const DEFAULT_DIM_Y = 'avg_p95_prb_ratio';
const DEFAULT_NUM_BINS = 8;
const ISLAND_SIZE = 420;
const ISLAND_GAP = 120;
const MARGIN = { top: 90, right: 60, bottom: 80, left: 90 };

let svg = null;
let g = null;
let zoomBehavior = null;
let lastTransform = null;

function getSelectedDimX() {
    const sel = document.getElementById('bins-dim-x');
    return sel ? sel.value : DEFAULT_DIM_X;
}

function getSelectedDimY() {
    const sel = document.getElementById('bins-dim-y');
    return sel ? sel.value : DEFAULT_DIM_Y;
}

function getNumBins() {
    const sel = document.getElementById('bins-count');
    return sel ? parseInt(sel.value, 10) || DEFAULT_NUM_BINS : DEFAULT_NUM_BINS;
}

function getBinNodeRadius(node) {
    const metric = 'combined_score';
    let minScore = Infinity, maxScore = -Infinity;
    const minR = 5, maxR = 22;

    if (Array.isArray(allNodeData) && allNodeData.length > 0) {
        allNodeData.forEach(n => {
            if (n.metrics && typeof n.metrics[metric] === 'number' && isFinite(n.metrics[metric])) {
                if (n.metrics[metric] < minScore) minScore = n.metrics[metric];
                if (n.metrics[metric] > maxScore) maxScore = n.metrics[metric];
            }
        });
        if (minScore === Infinity) minScore = 0;
        if (maxScore === -Infinity) maxScore = 1;
    } else {
        minScore = 0;
        maxScore = 1;
    }

    const score = node.metrics && typeof node.metrics[metric] === 'number' ? node.metrics[metric] : null;
    if (score === null || isNaN(score)) return minR / 2;
    if (maxScore === minScore) return (minR + maxR) / 2;
    const clamped = Math.max(minScore, Math.min(maxScore, score));
    return minR + (maxR - minR) * (clamped - minScore) / (maxScore - minScore);
}

function getNodeAbsolutePos(node, islandIndex, xScale, yScale, dimX, dimY) {
    const offsetX = MARGIN.left + islandIndex * (ISLAND_SIZE + ISLAND_GAP);
    const offsetY = MARGIN.top;
    const mx = node.metrics?.[dimX];
    const my = node.metrics?.[dimY];
    if (typeof mx !== 'number' || !isFinite(mx) || typeof my !== 'number' || !isFinite(my)) {
        return null;
    }
    return {
        x: offsetX + xScale(mx),
        y: offsetY + yScale(my)
    };
}

function updateBinsGraph(nodes, options = {}) {
    const binsView = document.getElementById('view-bins');
    if (!binsView) return;

    const dimX = getSelectedDimX();
    const dimY = getSelectedDimY();
    const numBins = getNumBins();

    const islands = Array.from(new Set(nodes.map(n => n.island))).sort((a, b) => a - b);
    const islandIndexMap = {};
    islands.forEach((island, idx) => { islandIndexMap[island] = idx; });

    const xValues = nodes
        .map(n => n.metrics?.[dimX])
        .filter(v => typeof v === 'number' && isFinite(v));
    const yValues = nodes
        .map(n => n.metrics?.[dimY])
        .filter(v => typeof v === 'number' && isFinite(v));

    if (!xValues.length || !yValues.length) {
        let msg = document.getElementById('bins-no-data-msg');
        if (!msg) {
            msg = document.createElement('div');
            msg.id = 'bins-no-data-msg';
            msg.style.cssText = 'padding:2em;color:#888;font-size:1.2em;';
            binsView.appendChild(msg);
        }
        msg.textContent = 'No data available for the selected feature dimensions.';
        msg.style.display = 'block';
        if (svg) { svg.style('display', 'none'); }
        return;
    }
    const noDataMsg = document.getElementById('bins-no-data-msg');
    if (noDataMsg) noDataMsg.style.display = 'none';

    const xExtent = d3.extent(xValues);
    const yExtent = d3.extent(yValues);

    const xScale = d3.scaleLinear().domain(xExtent).nice().range([0, ISLAND_SIZE]);
    const yScale = d3.scaleLinear().domain(yExtent).nice().range([ISLAND_SIZE, 0]);

    const totalWidth = MARGIN.left + islands.length * ISLAND_SIZE + (islands.length - 1) * ISLAND_GAP + MARGIN.right;
    const totalHeight = MARGIN.top + ISLAND_SIZE + MARGIN.bottom;

    if (!svg || svg.empty()) {
        svg = d3.select('#view-bins').select('svg#bins-graph');
        if (svg.empty()) {
            svg = d3.select('#view-bins')
                .append('svg')
                .attr('id', 'bins-graph')
                .style('display', 'block');
        }
    }
    svg.style('display', 'block');

    svg.attr('width', Math.max(totalWidth, window.innerWidth - 50))
       .attr('height', Math.max(totalHeight, window.innerHeight - document.getElementById('toolbar').offsetHeight - 80));

    g = svg.select('g.bins-zoom-group');
    if (g.empty()) {
        g = svg.append('g').attr('class', 'bins-zoom-group');
    }

    if (!zoomBehavior) {
        zoomBehavior = d3.zoom()
            .scaleExtent([0.2, 10])
            .on('zoom', function(event) {
                g.attr('transform', event.transform);
                lastTransform = event.transform;
            });
        svg.call(zoomBehavior);
    }

    if (!options.resetZoom && lastTransform) {
        svg.call(zoomBehavior.transform, lastTransform);
    }

    g.selectAll('*').remove();

    svg.on('click', function(event) {
        if (event.target === svg.node()) {
            setSelectedProgramId(null);
            setSidebarSticky(false);
            hideSidebar();
            g.selectAll('circle.bins-node')
                .classed('node-selected', false)
                .attr('stroke', '#333')
                .attr('stroke-width', 1.5);
            selectListNodeById(null);
            updateBinsEdgeHighlighting();
        }
    });

    const nodeById = Object.fromEntries(nodes.map(n => [n.id, n]));
    const highlightFilter = document.getElementById('highlight-select').value;
    const highlightMetric = document.getElementById('metric-select')?.value || 'combined_score';
    const highlightNodes = getHighlightNodes(nodes, highlightFilter, highlightMetric);
    const highlightIds = new Set(highlightNodes.map(n => n.id));

    const allEdges = [];

    islands.forEach((island, islandIdx) => {
        const offsetX = MARGIN.left + islandIdx * (ISLAND_SIZE + ISLAND_GAP);
        const offsetY = MARGIN.top;

        const islandG = g.append('g')
            .attr('class', 'bins-island')
            .attr('transform', `translate(${offsetX}, ${offsetY})`);

        const niceDomainX = xScale.domain();
        const niceDomainY = yScale.domain();

        for (let i = 0; i <= numBins; i++) {
            const fracX = niceDomainX[0] + (niceDomainX[1] - niceDomainX[0]) * i / numBins;
            const fracY = niceDomainY[0] + (niceDomainY[1] - niceDomainY[0]) * i / numBins;

            islandG.append('line')
                .attr('class', 'bins-grid')
                .attr('x1', xScale(fracX)).attr('y1', 0)
                .attr('x2', xScale(fracX)).attr('y2', ISLAND_SIZE)
                .attr('stroke', '#ddd').attr('stroke-width', i === 0 || i === numBins ? 1.5 : 0.8)
                .attr('stroke-dasharray', i === 0 || i === numBins ? 'none' : '4,3')
                .attr('pointer-events', 'none');

            islandG.append('line')
                .attr('class', 'bins-grid')
                .attr('x1', 0).attr('y1', yScale(fracY))
                .attr('x2', ISLAND_SIZE).attr('y2', yScale(fracY))
                .attr('stroke', '#ddd').attr('stroke-width', i === 0 || i === numBins ? 1.5 : 0.8)
                .attr('stroke-dasharray', i === 0 || i === numBins ? 'none' : '4,3')
                .attr('pointer-events', 'none');
        }

        for (let row = 0; row < numBins; row++) {
            for (let col = 0; col < numBins; col++) {
                const x0 = xScale(niceDomainX[0] + (niceDomainX[1] - niceDomainX[0]) * col / numBins);
                const y0 = yScale(niceDomainY[0] + (niceDomainY[1] - niceDomainY[0]) * (row + 1) / numBins);
                const cellW = xScale(niceDomainX[0] + (niceDomainX[1] - niceDomainX[0]) * (col + 1) / numBins) - x0;
                const cellH = yScale(niceDomainY[0] + (niceDomainY[1] - niceDomainY[0]) * row / numBins) - y0;

                islandG.append('rect')
                    .attr('class', 'bins-cell')
                    .attr('x', x0).attr('y', y0)
                    .attr('width', cellW).attr('height', cellH)
                    .attr('fill', (row + col) % 2 === 0 ? 'rgba(0,0,0,0.015)' : 'rgba(0,0,0,0.035)')
                    .attr('stroke', 'none')
                    .attr('pointer-events', 'none');
            }
        }

        islandG.append('text')
            .attr('class', 'bins-island-title')
            .attr('x', ISLAND_SIZE / 2)
            .attr('y', -30)
            .attr('text-anchor', 'middle')
            .attr('font-size', '1.4em')
            .attr('font-weight', 700)
            .attr('fill', '#444')
            .attr('pointer-events', 'none')
            .text(`Island ${island}`);

        const xAxis = d3.axisBottom(xScale).ticks(6);
        islandG.append('g')
            .attr('class', 'bins-axis')
            .attr('transform', `translate(0, ${ISLAND_SIZE})`)
            .call(xAxis)
            .selectAll('text').attr('font-size', '0.9em');

        islandG.append('text')
            .attr('class', 'bins-axis-label')
            .attr('x', ISLAND_SIZE / 2)
            .attr('y', ISLAND_SIZE + 50)
            .attr('text-anchor', 'middle')
            .attr('font-size', '1.05em')
            .attr('fill', '#666')
            .text(dimX);

        const yAxis = d3.axisLeft(yScale).ticks(6);
        islandG.append('g')
            .attr('class', 'bins-axis')
            .call(yAxis)
            .selectAll('text').attr('font-size', '0.9em');

        islandG.append('text')
            .attr('class', 'bins-axis-label')
            .attr('transform', 'rotate(-90)')
            .attr('x', -ISLAND_SIZE / 2)
            .attr('y', -55)
            .attr('text-anchor', 'middle')
            .attr('font-size', '1.05em')
            .attr('fill', '#666')
            .text(dimY);

        const islandNodes = nodes.filter(n => n.island === island);
        islandNodes.forEach(n => {
            if (!n.parent_id || !nodeById[n.parent_id]) return;
            const parent = nodeById[n.parent_id];
            const parentIslandIdx = islandIndexMap[parent.island];
            const childPos = getNodeAbsolutePos(n, islandIdx, xScale, yScale, dimX, dimY);
            const parentPos = getNodeAbsolutePos(parent, parentIslandIdx, xScale, yScale, dimX, dimY);
            if (!childPos || !parentPos) return;
            allEdges.push({ source: parent, target: n, x1: parentPos.x, y1: parentPos.y, x2: childPos.x, y2: childPos.y });
        });
    });

    const edgeG = g.append('g').attr('class', 'bins-edges');
    edgeG.selectAll('line.bins-edge')
        .data(allEdges)
        .enter()
        .append('line')
        .attr('class', 'bins-edge')
        .attr('x1', d => d.x1).attr('y1', d => d.y1)
        .attr('x2', d => d.x2).attr('y2', d => d.y2)
        .attr('stroke', d => {
            if (selectedProgramId && (d.source.id === selectedProgramId || d.target.id === selectedProgramId)) return 'red';
            return '#888';
        })
        .attr('stroke-width', d => {
            if (selectedProgramId && (d.source.id === selectedProgramId || d.target.id === selectedProgramId)) return 3;
            return 1.2;
        })
        .attr('opacity', d => {
            if (selectedProgramId && (d.source.id === selectedProgramId || d.target.id === selectedProgramId)) return 0.9;
            return 0.35;
        })
        .attr('pointer-events', 'none');

    const nodeG = g.append('g').attr('class', 'bins-nodes');
    const validNodes = nodes.filter(n => {
        const mx = n.metrics?.[dimX];
        const my = n.metrics?.[dimY];
        return typeof mx === 'number' && isFinite(mx) && typeof my === 'number' && isFinite(my);
    });

    nodeG.selectAll('circle.bins-node')
        .data(validNodes, d => d.id)
        .enter()
        .append('circle')
        .attr('class', 'bins-node')
        .attr('cx', d => {
            const idx = islandIndexMap[d.island];
            return MARGIN.left + idx * (ISLAND_SIZE + ISLAND_GAP) + xScale(d.metrics[dimX]);
        })
        .attr('cy', d => MARGIN.top + yScale(d.metrics[dimY]))
        .attr('r', d => getBinNodeRadius(d))
        .attr('fill', d => getNodeColor(d))
        .attr('stroke', d => selectedProgramId === d.id ? 'red' : (highlightIds.has(d.id) ? '#2196f3' : '#333'))
        .attr('stroke-width', d => selectedProgramId === d.id ? 3 : 1.5)
        .attr('opacity', 0.85)
        .each(function(d) {
            d3.select(this)
                .classed('node-highlighted', highlightIds.has(d.id))
                .classed('node-selected', selectedProgramId === d.id);
        })
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
            event.stopPropagation();
            setSelectedProgramId(d.id);
            window._lastSelectedNodeData = d;
            setSidebarSticky(true);
            selectListNodeById(d.id);
            g.selectAll('circle.bins-node')
                .classed('node-hovered', false)
                .classed('node-selected', false)
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
            updateBinsEdgeHighlighting();
        });

    if (options.autoZoom || (!lastTransform && nodes.length)) {
        zoomBinsToFit();
    }
}

function updateBinsEdgeHighlighting() {
    if (!g) return;
    g.selectAll('line.bins-edge')
        .attr('stroke', d => (selectedProgramId && (d.source.id === selectedProgramId || d.target.id === selectedProgramId)) ? 'red' : '#888')
        .attr('stroke-width', d => (selectedProgramId && (d.source.id === selectedProgramId || d.target.id === selectedProgramId)) ? 3 : 1.2)
        .attr('opacity', d => (selectedProgramId && (d.source.id === selectedProgramId || d.target.id === selectedProgramId)) ? 0.9 : 0.35);
}

function zoomBinsToFit() {
    if (!svg || !g) return;
    const nodeCircles = g.selectAll('circle.bins-node').nodes();
    if (!nodeCircles.length) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    nodeCircles.forEach(node => {
        const bbox = node.getBBox();
        minX = Math.min(minX, bbox.x);
        minY = Math.min(minY, bbox.y);
        maxX = Math.max(maxX, bbox.x + bbox.width);
        maxY = Math.max(maxY, bbox.y + bbox.height);
    });
    g.selectAll('.bins-island').each(function() {
        const bbox = this.getBBox();
        const transform = d3.select(this).attr('transform');
        const match = transform?.match(/translate\(([^,]+),\s*([^)]+)\)/);
        if (match) {
            const tx = parseFloat(match[1]);
            const ty = parseFloat(match[2]);
            minX = Math.min(minX, tx + bbox.x);
            minY = Math.min(minY, ty + bbox.y);
            maxX = Math.max(maxX, tx + bbox.x + bbox.width);
            maxY = Math.max(maxY, ty + bbox.y + bbox.height);
        }
    });
    const pad = 50;
    minX -= pad; minY -= pad; maxX += pad; maxY += pad;
    const svgW = +svg.attr('width');
    const svgH = +svg.attr('height');
    const scale = Math.min(svgW / (maxX - minX), svgH / (maxY - minY), 1.5);
    const tx = svgW / 2 - scale * (minX + (maxX - minX) / 2);
    const ty = svgH / 2 - scale * (minY + (maxY - minY) / 2);
    const t = d3.zoomIdentity.translate(tx, ty).scale(scale);
    svg.transition().duration(400).call(zoomBehavior.transform, t);
    lastTransform = t;
}

function populateDimensionSelects(nodes) {
    const metrics = new Set();
    nodes.forEach(node => {
        if (node.metrics) {
            Object.keys(node.metrics).forEach(m => {
                const vals = nodes.filter(n => n.metrics && typeof n.metrics[m] === 'number' && isFinite(n.metrics[m]));
                if (vals.length > 0) metrics.add(m);
            });
        }
    });

    const selX = document.getElementById('bins-dim-x');
    const selY = document.getElementById('bins-dim-y');
    if (!selX || !selY) return;

    const prevX = selX.value;
    const prevY = selY.value;
    selX.innerHTML = '';
    selY.innerHTML = '';

    const sorted = Array.from(metrics).sort();
    sorted.forEach(m => {
        const optX = document.createElement('option');
        optX.value = m;
        optX.textContent = m;
        selX.appendChild(optX);

        const optY = document.createElement('option');
        optY.value = m;
        optY.textContent = m;
        selY.appendChild(optY);
    });

    if (prevX && metrics.has(prevX)) selX.value = prevX;
    else if (metrics.has(DEFAULT_DIM_X)) selX.value = DEFAULT_DIM_X;
    else if (sorted.length) selX.value = sorted[0];

    if (prevY && metrics.has(prevY)) selY.value = prevY;
    else if (metrics.has(DEFAULT_DIM_Y)) selY.value = DEFAULT_DIM_Y;
    else if (sorted.length > 1) selY.value = sorted[1];
    else if (sorted.length) selY.value = sorted[0];
}

(function() {
    window.addEventListener('DOMContentLoaded', function() {
        const binsView = document.getElementById('view-bins');
        if (!binsView) return;

        let controlsDiv = document.getElementById('bins-controls');
        if (!controlsDiv) {
            controlsDiv = document.createElement('div');
            controlsDiv.id = 'bins-controls';
            controlsDiv.style.cssText = 'display:flex;align-items:center;gap:1em;padding:0.5em 1em;flex-wrap:wrap;';
            controlsDiv.innerHTML = `
                <label style="font-weight:500;font-size:1em;">X:
                    <select id="bins-dim-x" style="font-size:1em;padding:0.2em 0.5em;border-radius:4px;border:1px solid #bbb;"></select>
                </label>
                <label style="font-weight:500;font-size:1em;">Y:
                    <select id="bins-dim-y" style="font-size:1em;padding:0.2em 0.5em;border-radius:4px;border:1px solid #bbb;"></select>
                </label>
                <label style="font-weight:500;font-size:1em;">Bins:
                    <select id="bins-count" style="font-size:1em;padding:0.2em 0.5em;border-radius:4px;border:1px solid #bbb;">
                        <option value="4">4</option>
                        <option value="6">6</option>
                        <option value="8" selected>8</option>
                        <option value="10">10</option>
                        <option value="12">12</option>
                        <option value="16">16</option>
                    </select>
                </label>
            `;
            binsView.insertBefore(controlsDiv, binsView.firstChild);
        }

        document.getElementById('bins-dim-x').addEventListener('change', () => {
            lastTransform = null;
            updateBinsGraph(allNodeData, { resetZoom: true, autoZoom: true });
        });
        document.getElementById('bins-dim-y').addEventListener('change', () => {
            lastTransform = null;
            updateBinsGraph(allNodeData, { resetZoom: true, autoZoom: true });
        });
        document.getElementById('bins-count').addEventListener('change', () => {
            updateBinsGraph(allNodeData);
        });

        document.getElementById('tab-bins').addEventListener('click', function() {
            if (typeof allNodeData !== 'undefined' && allNodeData.length) {
                populateDimensionSelects(allNodeData);
                updateBinsGraph(allNodeData, { autoZoom: true });
            }
        });

        const metricSelect = document.getElementById('metric-select');
        if (metricSelect) {
            metricSelect.addEventListener('change', function() {
                const binsTab = document.getElementById('tab-bins');
                if (binsTab && binsTab.classList.contains('active')) {
                    updateBinsGraph(allNodeData);
                }
            });
        }
        const highlightSelect = document.getElementById('highlight-select');
        if (highlightSelect) {
            highlightSelect.addEventListener('change', function() {
                const binsTab = document.getElementById('tab-bins');
                if (binsTab && binsTab.classList.contains('active')) {
                    updateBinsGraph(allNodeData);
                }
            });
        }

        window.addEventListener('resize', function() {
            const binsTab = document.getElementById('tab-bins');
            if (binsTab && binsTab.classList.contains('active') && allNodeData.length) {
                updateBinsGraph(allNodeData);
            }
        });

        window.updateBinsGraph = function(nodes, opts) {
            populateDimensionSelects(nodes);
            updateBinsGraph(nodes, opts);
        };

        if (typeof allNodeData !== 'undefined' && allNodeData.length) {
            populateDimensionSelects(allNodeData);
            updateBinsGraph(allNodeData);
        }
    });
})();

window.addEventListener('node-selected', function() {
    if (!g) return;
    updateBinsEdgeHighlighting();
    g.selectAll('circle.bins-node')
        .attr('stroke', function(d) {
            const highlightFilter = document.getElementById('highlight-select')?.value;
            const highlightMetric = document.getElementById('metric-select')?.value || 'combined_score';
            const highlightNodes = getHighlightNodes(allNodeData, highlightFilter, highlightMetric);
            const highlightIds = new Set(highlightNodes.map(n => n.id));
            return selectedProgramId === d.id ? 'red' : (highlightIds.has(d.id) ? '#2196f3' : '#333');
        })
        .attr('stroke-width', d => selectedProgramId === d.id ? 3 : 1.5)
        .classed('node-selected', d => selectedProgramId === d.id);
});
