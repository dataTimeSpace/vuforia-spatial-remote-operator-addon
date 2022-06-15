createNameSpace('realityEditor.device.cameraVis');

import * as THREE from '../../thirdPartyCode/three/three.module.js';

(function(exports) {
    const debug = false;
    const ZDEPTH = true;
    const PROXY = window.location.host === 'toolboxedge.net';
    const ShaderMode = {
        SOLID: 'SOLID',
        POINT: 'POINT',
        HOLO: 'HOLO',
    };
    const shaderMode = ShaderMode.SOLID;
    const urlBase = 'ws://' + window.location.hostname + ':31337/';
    const vertexShader = `
uniform sampler2D map;
uniform sampler2D mapDepth;

uniform float width;
uniform float height;
uniform float depthScale;
uniform float glPosScale;

uniform float pointSize;
const float pointSizeBase = 0.0;

varying vec2 vUv;
varying vec4 pos;

const float XtoZ = 1920.0 / 1448.24976; // width over focal length
const float YtoZ = 1080.0 / 1448.24976;

void main() {
  vUv = vec2(position.x / width, position.y / height);

  vec4 color = texture2D(mapDepth, vUv);
  ${(!ZDEPTH) ? `
  float depth = (color.r * 255.0 + color.g + color.b / 255.0) * 1000.0;
  float z = depth - 0.05;
  ` : `
  // color.rgb are all 0-1 when we want them to be 0-255 so we can shift out across depth (mm?)
  int r = int(color.r * 255.0);
  int g = int(color.g * 255.0);
  int b = int(color.b * 255.0);

  float depth = float((r & 1) |
      ((g & 1) << 1) |
      ((b & 1) << 2) |
      ((r & (1 << 1)) << (3 - 1)) |
      ((g & (1 << 1)) << (4 - 1)) |
      ((b & (1 << 1)) << (5 - 1)) |
      ((r & (1 << 2)) << (6 - 2)) |
      ((g & (1 << 2)) << (7 - 2)) |
      ((b & (1 << 2)) << (8 - 2)) |
      ((r & (1 << 3)) << (9 - 3)) |
      ((g & (1 << 3)) << (10 - 3)) |
      ((b & (1 << 3)) << (11 - 3)) |
      ((r & (1 << 4)) << (12 - 4)) |
      ((g & (1 << 4)) << (13 - 4)) |
      ((b & (1 << 4)) << (14 - 4)) |
      ((r & (1 << 5)) << (15 - 5)) |
      ((g & (1 << 5)) << (16 - 5)) |
      ((b & (1 << 5)) << (17 - 5)) |
      ((r & (1 << 6)) << (18 - 6)) |
      ((g & (1 << 6)) << (19 - 6)) |
      ((b & (1 << 6)) << (20 - 6)) |
      ((r & (1 << 7)) << (21 - 7)) |
      ((g & (1 << 7)) << (22 - 7)) |
      ((b & (1 << 7)) << (23 - 7))) *
      (5000.0 / float(1 << 24));

  // Projection code by @kcmic

  float z = depth - 1.0;
  `}

  pos = vec4(
    (position.x / width - 0.5) * z * XtoZ,
    (position.y / height - 0.5) * z * YtoZ,
    -z,
    1.0);

  gl_Position = projectionMatrix * modelViewMatrix * pos;
  // gl_PointSize = pointSizeBase + pointSize * depth * depthScale;
  gl_PointSize = pointSizeBase + pointSize * depth * depthScale + glPosScale / gl_Position.w;
}`;

    const pointFragmentShader = `
uniform sampler2D map;

varying vec2 vUv;

void main() {
  vec4 color = texture2D(map, vUv);
  gl_FragColor = vec4(color.r, color.g, color.b, 0.4);
}`;

    const holoFragmentShader = `
// color texture
uniform sampler2D map;
uniform float time;

// uv (0.0-1.0) texture coordinates
varying vec2 vUv;
// Position of this pixel relative to the camera in proper (millimeter) coordinates
varying vec4 pos;

void main() {
  // Depth in millimeters
  float depth = -pos.z;

  // Fade out beginning at 4.5 meters and be gone after 5.0
  float alphaDepth = clamp(2.0 * (5.0 - depth / 1000.0), 0.0, 1.0);

  // Hologram effect :)
  float alphaHolo = clamp(round(sin(pos.y / 3.0 - 40.0 * time) - 0.3), 0.0, 1.0) *
                clamp(sin(gl_FragCoord.x / 10.0 + gl_FragCoord.y + 40.0 * time) + sin(5.0 * time) + 1.5, 0.0, 1.0);
                // clamp(sin(sqrt(pos.x * pos.x + pos.z * pos.z) / 3.0 + 0.5) + sin(10.0 * time) + 1.5, 0.0, 1.0);

  // Normal vector of the depth mesh based on pos
  // Necessary to calculate manually since we're messing with gl_Position in the vertex shader
  vec3 normal = normalize(cross(dFdx(pos.xyz), dFdy(pos.xyz)));

  // pos.xyz is the ray looking out from the camera to this pixel
  // dot of pos.xyz and the normal is to what extent this pixel is flat
  // relative to the camera (alternatively, how much it's pointing at the
  // camera)
  // alphaDepth is thrown in here to incorporate the depth-based fade
  float alpha = abs(dot(normalize(pos.xyz), normal)) * alphaDepth * alphaHolo;

  // Sample the proper color for this pixel from the color image
  vec4 color = texture2D(map, vUv);

  gl_FragColor = vec4(color.rgb * vec3(0.1, 0.3, 0.3) + vec3(0.0, 0.7, 0.7), alpha);
}`;

    const solidFragmentShader = `
// color texture
uniform sampler2D map;

// uv (0.0-1.0) texture coordinates
varying vec2 vUv;
// Position of this pixel relative to the camera in proper (millimeter) coordinates
varying vec4 pos;

void main() {
  // Depth in millimeters
  float depth = -pos.z;

  // Fade out beginning at 4.5 meters and be gone after 5.0
  float alphaDepth = clamp(2.0 * (5.0 - depth / 1000.0), 0.0, 1.0);

  // Normal vector of the depth mesh based on pos
  // Necessary to calculate manually since we're messing with gl_Position in the vertex shader
  vec3 normal = normalize(cross(dFdx(pos.xyz), dFdy(pos.xyz)));

  // pos.xyz is the ray looking out from the camera to this pixel
  // dot of pos.xyz and the normal is to what extent this pixel is flat
  // relative to the camera (alternatively, how much it's pointing at the
  // camera)
  // alphaDepth is thrown in here to incorporate the depth-based fade
  float alpha = abs(dot(normalize(pos.xyz), normal)) * alphaDepth;

  // Sample the proper color for this pixel from the color image
  vec4 color = texture2D(map, vUv);

  gl_FragColor = vec4(color.rgb, alpha);
}`;

    function setMatrixFromArray(matrix, array) {
        matrix.set(
            array[0], array[4], array[8], array[12],
            array[1], array[5], array[9], array[13],
            array[2], array[6], array[10], array[14],
            array[3], array[7], array[11], array[15]
        );
    }

    class CameraVis {
        constructor(id, floorOffset) {
            this.id = id;
            this.container = new THREE.Group();
            // this.container.scale.set(0.001, 0.001, 0.001);
            // this.container.rotation.y = Math.PI;
            this.container.position.y = -floorOffset;
            this.container.rotation.x = Math.PI / 2;
            this.container.name = 'CameraVisContainer_' + id;
            this.lastUpdate = Date.now();
            this.phone = new THREE.Group();
            this.phone.matrixAutoUpdate = false;
            this.phone.frustumCulled = false;
            this.container.add(this.phone);

            let parentNode = realityEditor.sceneGraph.getVisualElement('CameraGroupContainer');
            // let parentNode = realityEditor.sceneGraph.getGroundPlaneNode();
            // let parentNode = realityEditor.sceneGraph.getSceneNodeById(elementId);
            let sceneGraphNodeId = realityEditor.sceneGraph.addVisualElement('CameraVis_' + id, parentNode);
            this.sceneGraphNode = realityEditor.sceneGraph.getSceneNodeById(sceneGraphNodeId);

            this.cameraMeshGroup = new THREE.Group();

            const geo = new THREE.BoxGeometry(100, 100, 80);
            let colorId = id;
            if (typeof id === 'string') {
                colorId = 0;
                for (let i = 0; i < id.length; i++) {
                    colorId ^= id.charCodeAt(i);
                }
            }
            const color = `hsl(${((colorId / 29) % Math.PI) * 360 / Math.PI}, 100%, 50%)`;
            const mat = new THREE.MeshBasicMaterial({color: color});
            const box = new THREE.Mesh(geo, mat);
            box.name = 'cameraVisCamera';
            box.cameraVisId = this.id;
            this.cameraMeshGroup.add(box);

            const geoCone = new THREE.ConeGeometry(60, 180, 16, 1);
            const cone = new THREE.Mesh(geoCone, mat);
            cone.rotation.x = -Math.PI / 2;
            cone.rotation.y = Math.PI / 8;
            cone.position.z = 65;
            cone.name = 'cameraVisCamera';
            cone.cameraVisId = this.id;
            this.cameraMeshGroup.add(cone);

            this.phone.add(this.cameraMeshGroup);

            this.texture = new THREE.Texture();
            this.texture.minFilter = THREE.NearestFilter;
            this.texture.magFilter = THREE.NearestFilter;

            this.textureDepth = new THREE.Texture();
            this.textureDepth.minFilter = THREE.NearestFilter;
            this.textureDepth.magFilter = THREE.NearestFilter;

            this.material = null;
            this.mesh = null;

            if (debug) {
                this.setupDebugCubes();
            }

            this.setupPointCloud();

            this.time = performance.now();
            this.matrices = [];
            this.loading = {};

            this.historyLine = new realityEditor.device.meshLine.MeshLine();
            const lineMat = new realityEditor.device.meshLine.MeshLineMaterial({
                color: color,
                opacity: 0.6,
                lineWidth: 20,
                // depthWrite: false,
                transparent: true,
                side: THREE.DoubleSide,
            });
            this.historyMesh = new THREE.Mesh(this.historyLine, lineMat);
            this.historyPoints = [];
            this.historyLine.setPoints(this.historyPoints);
            this.container.add(this.historyMesh);
        }

        /**
         * Clone the current state of the mesh rendering part of this CameraVis
         * @return {THREE.Object3D} object containing all relevant meshes
         */
        clonePatch() {
            const width = 640, height = 360;

            let patch = this.container.clone(false);
            let phone = this.phone.clone(false);
            let flatGeo = new THREE.PlaneBufferGeometry(width, height, width, height);
            flatGeo.translate(width / 2, height / 2);

            let material = this.material.clone();
            material.fragmentShader = solidFragmentShader;
            material.uniforms.map.value.image = this.texture.image; // .cloneNode();
            material.uniforms.map.value.needsUpdate = true;
            material.uniforms.mapDepth.value.image = this.textureDepth.image; // .cloneNode();
            material.uniforms.mapDepth.value.needsUpdate = true;

            let mesh = new THREE.Mesh(flatGeo, material);
            mesh.scale.set(-1, 1, -1);
            mesh.frustumCulled = false;

            phone.add(mesh);
            patch.add(phone);
            return patch;
        }

        setupDebugCubes() {
            let debugDepth = new THREE.MeshBasicMaterial({
                map: this.textureDepth,
            });
            let debugDepthCube = new THREE.Mesh(new THREE.PlaneGeometry(500, 500), debugDepth);
            this.container.add(debugDepthCube);
            debugDepthCube.position.set(400, 250, -1000);

            let debugColor = new THREE.MeshBasicMaterial({
                map: this.texture,
            });
            this.debugColorCube = new THREE.Mesh(new THREE.PlaneGeometry(100, 100 * 1080 / 1920), debugColor);
            // this.container.add(debugColorCube);
            this.debugColorCube.position.set(-180 * window.innerWidth / window.innerHeight, 140, -1000);
            this.debugColorCube.rotation.z = Math.PI;
        }

        toggleColorCube(i) {
            if (!this.debugColorCube || !this.debugColorCube.parent) {
                this.addColorCube(i);
            } else {
                this.removeColorCube();
            }
        }

        addColorCube(i) {
            if (!this.debugColorCube) {
                let debugColor = new THREE.MeshBasicMaterial({
                    map: this.texture,
                });
                this.debugColorCube = new THREE.Mesh(new THREE.PlaneGeometry(100, 100 * 1080 / 1920), debugColor);
                // this.container.add(debugColorCube);
                this.debugColorCube.rotation.z = Math.PI;
            }
            let x = -180 * window.innerWidth / window.innerHeight;
            let y = 140 - i * 100;
            this.debugColorCube.position.set(x, y, -1000);
            realityEditor.gui.threejsScene.addToScene(this.debugColorCube, {parentToCamera: true});
        }

        removeColorCube() {
            realityEditor.gui.threejsScene.removeFromScene(this.debugColorCube);
        }

        setupPointCloud() {
            const width = 640, height = 360;

            if (shaderMode !== ShaderMode.POINT) {
                this.geometry = new THREE.PlaneBufferGeometry(width, height, width / 5, height / 5);
                this.geometry.translate(width / 2, height / 2);
            } else {
                this.geometry = new THREE.BufferGeometry();
                const vertices = new Float32Array(width * height * 3);

                for (let i = 0, j = 0, l = vertices.length; i < l; i += 3, j ++) {
                    vertices[i] = j % width;
                    vertices[i + 1] = Math.floor(j / width);
                }

                this.geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
            }

            let fragmentShader;
            switch (shaderMode) {
            case ShaderMode.POINT:
                fragmentShader = pointFragmentShader;
                break;
            case ShaderMode.HOLO:
                fragmentShader = holoFragmentShader;
                break;
            case ShaderMode.SOLID:
            default:
                fragmentShader = solidFragmentShader;
                break;
            }

            this.material = new THREE.ShaderMaterial({
                uniforms: {
                    time: {value: window.performance.now()},
                    map: {value: this.texture},
                    mapDepth: {value: this.textureDepth},
                    width: {value: width},
                    height: {value: height},
                    depthScale: {value: 0.15 / 256}, // roughly 1 / 1920
                    glPosScale: {value: 20000}, // 0.15 / 256}, // roughly 1 / 1920
                    // pointSize: { value: 8 * 0.666 * 0.15 / 256 },
                    pointSize: { value: 2 * 0.666 },
                },
                vertexShader,
                fragmentShader,
                // blending: THREE.AdditiveBlending,
                // depthTest: false, depthWrite: false,
                transparent: true
            });

            if (shaderMode !== ShaderMode.POINT) {
                this.mesh = new THREE.Mesh(this.geometry, this.material);
            } else {
                this.mesh = new THREE.Points(this.geometry, this.material);
            }
            this.mesh.scale.set(-1, 1, -1);
            this.mesh.frustumCulled = false;
            this.phone.add(this.mesh);
        }

        update(mat) {
            let now = performance.now();
            if (shaderMode === ShaderMode.HOLO) {
                this.material.uniforms.time.value = window.performance.now();
            }
            this.lastUpdate = now;
            if (this.time > now) {
                this.setMatrix(mat);
                return;
            }
            this.matrices.push({
                matrix: mat,
                time: now,
            });
        }

        setTime(time) {
            this.time = time;
            if (this.matrices.length === 0) {
                return;
            }
            let latest = this.matrices[0];
            if (latest.time > time) {
                return;
            }
            let latestI = 0;
            for (let i = 1; i < this.matrices.length; i++) {
                let mat = this.matrices[i];
                if (mat.time > time) {
                    break;
                }
                latest = mat;
                latestI = i;
            }
            this.matrices.splice(0, latestI + 1);

            this.setMatrix(latest.matrix);
        }

        setMatrix(newMatrix) {
            setMatrixFromArray(this.phone.matrix, newMatrix);
            this.hideNearCamera(newMatrix[12], newMatrix[13], newMatrix[14]);
            let nextHistoryPoint = new THREE.Vector3(
                newMatrix[12],
                newMatrix[13],
                newMatrix[14],
            );

            let addToHistory = this.historyPoints.length === 0;
            if (this.historyPoints.length > 0) {
                let lastHistoryPoint = this.historyPoints[this.historyPoints.length - 1];
                let diffSq = (lastHistoryPoint.x - nextHistoryPoint.x) * (lastHistoryPoint.x - nextHistoryPoint.x) +
                    (lastHistoryPoint.y - nextHistoryPoint.y) * (lastHistoryPoint.y - nextHistoryPoint.y) +
                    (lastHistoryPoint.z - nextHistoryPoint.z) * (lastHistoryPoint.z - nextHistoryPoint.z);

                addToHistory = diffSq > 100 * 100;
            }

            if (addToHistory) {
                this.historyPoints.push(nextHistoryPoint);
                this.historyLine.setPoints(this.historyPoints);
            }

            if (this.sceneGraphNode) {
                this.sceneGraphNode.setLocalMatrix(newMatrix);
            }
        }

        hideNearCamera() {
            let mat = this.phone.matrix.clone();
            mat.premultiply(this.container.matrix);
            const x = mat.elements[12];
            const y = mat.elements[13];
            const z = mat.elements[14];

            let cameraNode = realityEditor.sceneGraph.getSceneNodeById('CAMERA');
            const cameraX = cameraNode.worldMatrix[12];
            const cameraY = cameraNode.worldMatrix[13];
            const cameraZ = cameraNode.worldMatrix[14];

            let diffSq = (cameraX - x) * (cameraX - x) +
                (cameraY - y) * (cameraY - y) +
                (cameraZ - z) * (cameraZ - z);

            if (diffSq < 3000 * 3000) {
                if (this.cameraMeshGroup.visible) {
                    this.cameraMeshGroup.visible = false;
                }
            } else if (!this.cameraMeshGroup.visible) {
                this.cameraMeshGroup.visible = true;
            }
        }

        add() {
            realityEditor.gui.threejsScene.addToScene(this.container);
        }

        remove() {
            realityEditor.gui.threejsScene.removeFromScene(this.container);
        }
    }

    exports.CameraVisCoordinator = class CameraVisCoordinator {
        constructor(floorOffset, voxelizer) {
            this.voxelizer = voxelizer;
            this.cameras = {};
            this.patches = [];
            this.visible = true;
            this.spaghettiVisible = true;
            this.floorOffset = floorOffset;
            this.depthCanvasCache = {};
            this.colorCanvasCache = {};
            this.showCanvasTimeout = null;
            this.callbacks = {
                onCameraVisCreated: []
            };

            realityEditor.gui.getMenuBar().addCallbackToItem(realityEditor.gui.ITEM.PointClouds, (toggled) => {
                this.visible = toggled;
                for (let camera of Object.values(this.cameras)) {
                    camera.mesh.visible = this.visible;
                    camera.mesh.__hidden = !this.visible;
                }
            });

            realityEditor.gui.getMenuBar().addCallbackToItem(realityEditor.gui.ITEM.ResetPaths, () => {
                for (let camera of Object.values(this.cameras)) {
                    camera.historyPoints = [];
                    camera.historyLine.setPoints(camera.historyPoints);
                }
            });

            realityEditor.gui.getMenuBar().addCallbackToItem(realityEditor.gui.ITEM.SpaghettiMap, (toggled) => {
                this.spaghettiVisible = toggled;
                for (let camera of Object.values(this.cameras)) {
                    camera.historyMesh.visible = this.spaghettiVisible;
                }
            });

            realityEditor.gui.getMenuBar().addCallbackToItem(realityEditor.gui.ITEM.ClonePatch, () => {
                for (let camera of Object.values(this.cameras)) {
                    let patch = camera.clonePatch();
                    realityEditor.gui.threejsScene.addToScene(patch);
                    this.patches.push(patch);
                }
            });

            this.onPointerDown = this.onPointerDown.bind(this);

            let threejsCanvas = document.getElementById('mainThreejsCanvas');
            if (threejsCanvas) {
                threejsCanvas.addEventListener('pointerdown', this.onPointerDown);
            }

            this.startWebRTC();
        }

        connectWsToMatrix(url) {
            if (PROXY) {
                const ws = realityEditor.cloud.socket;

                ws.on('message', async (route, body, cbObj, bin) => {
                    if (body.id !== 'matrix') {
                        return;
                    }

                    const id = bin.data[0];
                    // const pktType = bytes[1];
                    // if (pktType === PKT_MATRIX) {
                    const mat = new Float32Array(bin.data.slice(1, bin.data.length).buffer);
                    // }
                    this.updateMatrix(id, mat);
                });
            } else {
                const ws = new WebSocket(url);
                ws.addEventListener('message', async (msg) => {
                    const bytes = new Uint8Array(await msg.data.slice(0, 1).arrayBuffer());
                    const id = bytes[0];
                    const mat = new Float32Array(await msg.data.slice(1, msg.data.size).arrayBuffer());
                    this.updateMatrix(id, mat);
                });
            }
        }

        updateMatrix(id, mat) {
            if (!this.cameras[id]) {
                this.createCameraVis(id);
            }
            this.cameras[id].update(mat);

            let now = performance.now();
            for (let camera of Object.values(this.cameras)) {
                if (camera.mesh.__hidden) {
                    camera.mesh.visible = false;
                    continue;
                }
                if (now - camera.lastUpdate > 2000) {
                    camera.mesh.visible = false;
                } else if (!camera.mesh.visible) {
                    camera.mesh.visible = true;
                }
            }
        }

        connect() {
            const connectWsToTexture = (url, textureKey, mimetype) => {
                if (PROXY) {
                    const ws = realityEditor.cloud.socket;

                    ws.on('message', async (route, body, cbObj, bin) => {
                        if (body.id !== 'depth' && body.id !== 'color') {
                            return;
                        }
                        if (body.id === 'depth' && textureKey !== 'textureDepth') {
                            return;
                        }
                        if (body.id === 'color' && textureKey !== 'texture') {
                            return;
                        }

                        const bytes = new Uint8Array(bin.data.slice(0, 1));
                        const id = bytes[0];
                        const imageBlob = new Blob([bin.data.slice(1, bin.data.length).buffer], {type: mimetype});
                        const imageUrl = URL.createObjectURL(imageBlob);
                        this.renderPointCloud(id, textureKey, imageUrl);
                    });
                } else {
                    const ws = new WebSocket(url);

                    ws.addEventListener('message', async (msg) => {
                        const bytes = new Uint8Array(await msg.data.slice(0, 1).arrayBuffer());
                        const id = bytes[0];
                        const imageBlob = msg.data.slice(1, msg.data.size, mimetype);
                        const imageUrl = URL.createObjectURL(imageBlob);
                        this.renderPointCloud(id, textureKey, imageUrl);
                    });
                }
            };

            const urlColor = urlBase + 'color';
            const urlDepth = urlBase + 'depth';
            const urlMatrix = urlBase + 'matrix';

            connectWsToTexture(urlColor, 'texture', 'image/jpeg');
            connectWsToTexture(urlDepth, 'textureDepth', 'image/png');
            this.connectWsToMatrix(urlMatrix);
        }

        startWebRTC() {
            const network = 'cam' + Math.floor(Math.random() * 1000);

            const ws = PROXY ? realityEditor.cloud.socket : new WebSocket(urlBase + 'signalling');
            const _coordinator = new realityEditor.device.cameraVis.WebRTCCoordinator(this, ws, network);
        }

        renderPointCloud(id, textureKey, imageUrl) {
            if (!this.cameras[id]) {
                this.createCameraVis(id);
            }
            if (this.cameras[id].loading[textureKey]) {
                return;
            }
            this.cameras[id].loading[textureKey] = true;
            // const pktType = bytes[1];
            // if (pktType === PKT_MATRIX) {
            //   const text = await msg.data.slice(2, msg.data.length).text();
            //   const mat = JSON.parse(text);
            // }

            const image = new Image();

            let start = window.performance.now();
            image.onload = () => {
                const tex = this.cameras[id][textureKey];
                tex.dispose();
                // hmmmmm
                // most efficient would be if this had a data url for its src
                // data url = 'data:image/(png|jpeg);' + base64(blob)
                if (textureKey === 'textureDepth') {
                    if (!this.depthCanvasCache.hasOwnProperty(id)) {
                        let canvas = document.createElement('canvas');
                        this.depthCanvasCache[id] = {
                            canvas,
                            context: canvas.getContext('2d'),
                        };
                    }
                    let {canvas, context} = this.depthCanvasCache[id];
                    canvas.width = image.width;
                    canvas.height = image.height;
                    context.drawImage(image, 0, 0, image.width, image.height);
                    tex.image = canvas;
                    if (this.voxelizer) {
                        this.voxelizer.raycastDepthTexture(
                            this.cameras[id].phone, canvas, context);
                    }
                } else {
                    if (!this.colorCanvasCache.hasOwnProperty(id)) {
                        let canvas = document.createElement('canvas');
                        this.colorCanvasCache[id] = {
                            canvas,
                            context: canvas.getContext('2d'),
                        };
                    }
                    let {canvas, context} = this.colorCanvasCache[id];
                    canvas.width = image.width;
                    canvas.height = image.height;
                    context.drawImage(image, 0, 0, image.width, image.height);
                    tex.image = canvas;
                    // tex.image = image;
                }
                tex.needsUpdate = true;
                // let end = window.performance.now();
                if (textureKey === 'texture') {
                    // We know that capture takes 30ms
                    // Transmission takes ??s
                    this.cameras[id].setTime(start + 40);
                }
                this.cameras[id].loading[textureKey] = false;
                // window.latencies[textureKey].push(end - start);
                URL.revokeObjectURL(imageUrl);
            };
            image.onerror = (e) => {
                console.error(e);
            };
            image.src = imageUrl;
        }

        showFullscreenColorCanvas(id) {
            let cacheId = id;
            if (!this.colorCanvasCache.hasOwnProperty(cacheId)) {
                cacheId = 'prov' + id;
            }

            if (this.colorCanvasCache[cacheId] && !this.showCanvasTimeout) {
                let canvas = this.colorCanvasCache[cacheId].canvas;
                canvas.style.position = 'absolute';
                canvas.style.left = '0';
                canvas.style.top = '0';
                canvas.style.width = '100vw';
                canvas.style.height = '100vh';
                canvas.style.transform = 'rotate(180deg)';
                // canvas.style.transition = 'opacity 1.0s ease-in-out';
                // canvas.style.opacity = '0';
                canvas.id = 'colorCanvas' + id;
                this.showCanvasTimeout = setTimeout(() => {
                    document.body.appendChild(canvas);
                }, 300);
                // setTimeout(() => {
                //     canvas.style.opacity = '1.0';
                // }, 100);
            }
        }

        hideFullscreenColorCanvas(id) {
            if (this.showCanvasTimeout) {
                clearInterval(this.showCanvasTimeout);
                this.showCanvasTimeout = null;
            }

            let canvas = document.getElementById('colorCanvas' + id);
            if (canvas && canvas.parentElement) {
                // canvas.style.opacity = '0';
                canvas.parentElement.removeChild(canvas);
            }
        }

        loadPointCloud(id, textureUrl, textureDepthUrl, matrix) {
            this.renderPointCloud(id, 'texture', textureUrl);
            this.renderPointCloud(id, 'textureDepth', textureDepthUrl);
            this.updateMatrix(id, matrix);
        }

        hidePointCloud(id) {
            if (!this.cameras[id]) {
                console.log('No need to hide camera ' + id + ', it hasn\'t been created yet.');
                return;
            }
            let camera = this.cameras[id];
            if (camera.mesh) {
                camera.mesh.visible = false;
            }
        }

        onCameraVisCreated(cb) {
            this.callbacks.onCameraVisCreated.push(cb);
        }

        createCameraVis(id) {
            if (debug) {
                console.log('new camera', id);
            }
            this.cameras[id] = new CameraVis(id, this.floorOffset);
            this.cameras[id].add();

            // these menubar shortcuts are disabled by default, enabled when at least one virtualizer connects
            realityEditor.gui.getMenuBar().setItemEnabled(realityEditor.gui.ITEM.PointClouds, true);
            realityEditor.gui.getMenuBar().setItemEnabled(realityEditor.gui.ITEM.SpaghettiMap, true);
            realityEditor.gui.getMenuBar().setItemEnabled(realityEditor.gui.ITEM.ResetPaths, true);
            realityEditor.gui.getMenuBar().setItemEnabled(realityEditor.gui.ITEM.TogglePaths, true);
            realityEditor.gui.getMenuBar().setItemEnabled(realityEditor.gui.ITEM.ClonePatch, true);
            realityEditor.gui.getMenuBar().setItemEnabled(realityEditor.gui.ITEM.StopFollowing, true);
            Object.values(realityEditor.device.desktopCamera.perspectives).forEach(info => {
                realityEditor.gui.getMenuBar().setItemEnabled(info.menuBarName, true);
            });

            this.callbacks.onCameraVisCreated.forEach(cb => {
                cb(this.cameras[id]);
            });
        }

        onPointerDown(e) {
            let objectsToCheck = Object.values(this.cameras).map(cameraVis => {
                return cameraVis.cameraMeshGroup;
            });
            let intersects = realityEditor.gui.threejsScene.getRaycastIntersects(e.clientX, e.clientY, objectsToCheck);

            intersects.forEach((intersect) => {
                if (intersect.object.name !== 'cameraVisCamera') {
                    return;
                }

                let id = intersect.object.cameraVisId;
                let i = Object.keys(this.cameras).indexOf('' + id);
                this.cameras[id].toggleColorCube(i);

                // stop propagation if we hit anything, otherwise pass the event on to the rest of the application
                e.stopPropagation();
            });
        }
    };

})(realityEditor.device.cameraVis);
