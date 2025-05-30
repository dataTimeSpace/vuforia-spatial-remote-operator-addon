createNameSpace('realityEditor.device.cameraVis');

import RVLParser from '../../thirdPartyCode/rvl/RVLParser.js';
import { iceServers } from './config.js';

(function(exports) {
    const DEPTH_REPR_FORCE_PNG = false;
    const DEBUG = false;
    // Coordinator re-sends joinNetwork message at this interval of ms until
    // discoverPeers acknowledgement is received from remote peer
    const JOIN_NETWORK_INTERVAL = 5000;

    const decoder = new TextDecoder();

    const ErrorMessage = {
        autoplayBlocked: 'Autoplay blocked. Interact with page or grant permission in browser settings.',
        noMicrophonePermissions: 'No microphone permission. Grant permission from browser and refresh page.',
        webrtcIssue: 'Internal WebRTC issue.',
    };

    /**
     * @param {ErrorMessage} message - human readable error text
     * @param {Error} error - error responsible for causing this
     * @param errorId - html element id for parent div
     * @param errorTextId - html element for error text
     * @param {number} duration - ms duration of notification popup
     */
    function showError(message, error, errorId, errorTextId, duration) {
        console.error('webrtc error', error);
        // showBannerNotification removes notification after set time so no additional function is needed
        realityEditor.gui.modal.showBannerNotification(message, errorId, errorTextId, duration);
    }

    class WebRTCCoordinator {
        constructor(cameraVisCoordinator, ws, consumerId) {
            this.cameraVisCoordinator = cameraVisCoordinator;
            /** @type ToolSocket */
            this.ws = ws;
            this.audioStream = null;
            this.consumerId = consumerId;
            this.muted = true;

            // setInterval result used for repeatedly sending joinNetwork
            this.joinNetworkInterval = null;

            this.webrtcConnections = {};

            this.subscribedObjects = {};

            this.onToolsocketMessage = this.onToolsocketMessage.bind(this);
            this.sendSignallingMessage = this.sendSignallingMessage.bind(this);

            this.ws.on('/signalling', this.onToolsocketMessage);
            const joinNetwork = () => {
                this.sendSignallingMessage({
                    command: 'joinNetwork',
                    src: this.consumerId,
                    role: 'consumer',
                });
            };
            joinNetwork();
            this.joinNetworkInterval = setInterval(joinNetwork, JOIN_NETWORK_INTERVAL);

            this.audioStreamPromise = navigator.mediaDevices.getUserMedia({
                video: false,
                audio: {
                    noiseSuppression: true,
                },
            }).then((stream) => {
                this.audioStream = this.improveAudioStream(stream);
                for (let conn of Object.values(this.webrtcConnections)) {
                    conn.audioStream = this.audioStream;
                    conn.localConnection.addStream(conn.audioStream);
                }
                this.updateMutedState();
            }).catch(err => {
                showError(ErrorMessage.noMicrophonePermissions, err, 'audioErrorUI', 'audioErrorText', 10000);
            });
        }

        sendSignallingMessage(message) {
            let identifier = 'unused';
            const worldObject = realityEditor.worldObjects.getBestWorldObject();
            if (worldObject) {
                identifier = worldObject.port;
                if (!this.subscribedObjects[identifier]) {
                    this.subscribedObjects[identifier] = true;
                    let serverSocket = realityEditor.network.realtime.getServerSocketForObject(worldObject.objectId);
                    serverSocket.on('/signalling', this.onToolsocketMessage);
                }
            }
            this.ws.emit(realityEditor.network.getIoTitle(identifier, '/signalling'), message);
        }

        improveAudioStream(stream) {
            const context = new AudioContext();
            const src = context.createMediaStreamSource(stream);
            const dst = context.createMediaStreamDestination();
            const gainNode = context.createGain();
            gainNode.gain.value = 6;
            src.connect(gainNode);
            gainNode.connect(dst);
            return dst.stream;
        }

        updateMutedState() {
            if (!this.audioStream) return;
            for (let track of this.audioStream.getTracks()) {
                track.enabled = !this.muted;
            }
        }

        mute() {
            this.muted = true;
            this.updateMutedState();
        }

        unmute() {
            this.muted = false;
            this.updateMutedState();
        }

        async onToolsocketMessage(msgRaw) {
            let msg;
            try {
                msg = typeof msgRaw === 'string' ? JSON.parse(msgRaw) : msgRaw;
            } catch (e) {
                console.warn('ws parse error', e, event);
                return;
            }
            if (DEBUG) {
                console.log('webrtc msg', msg);
            }

            if (msg.command === 'joinNetwork') {
                if (msg.role === 'provider') {
                    await this.initConnection(msg.src);
                }
                return;
            }

            if (msg.command === 'discoverPeers' && msg.dest === this.consumerId) {
                if (this.joinNetworkInterval) {
                    clearInterval(this.joinNetworkInterval);
                    this.joinNetworkInterval = null;
                }
                for (let provider of msg.providers) {
                    await this.initConnection(provider);
                }
                for (let consumer of msg.consumers) {
                    if (consumer !== this.consumerId) {
                        await this.initConnection(consumer);
                    }
                }
                return;
            }

            if (msg.dest !== this.consumerId) {
                if (DEBUG) {
                    console.warn('discarding not mine', this.consumerId, msg);
                }
                return;
            }

            if (!this.webrtcConnections[msg.src]) {
                if (!this.audioStream) {
                    await this.audioStreamPromise;
                }

                this.webrtcConnections[msg.src] = new WebRTCConnection(
                    this.sendSignallingMessage,
                    this.cameraVisCoordinator,
                    this.ws,
                    this.audioStream,
                    this.consumerId,
                    msg.src
                );
                this.webrtcConnections[msg.src].initLocalConnection();
            }
            this.webrtcConnections[msg.src].onSignallingMessage(msg);
        }

        async initConnection(otherId) {
            const conn = this.webrtcConnections[otherId];
            const goodChannelStates = ['connecting', 'open'];

            if (conn) {
                // connection already as good as it gets
                if (conn.receiveChannel &&
                    goodChannelStates.includes(conn.receiveChannel.readyState)) {
                    return;
                }

                // This was initiated by the provider side, don't mess with it
                if (!conn.offered) {
                    return;
                }
            }

            if (!this.audioStream) {
                await this.audioStreamPromise;
            }

            let newConn = new WebRTCConnection(
                this.sendSignallingMessage,
                this.cameraVisCoordinator,
                this.ws,
                this.audioStream,
                this.consumerId,
                otherId,
            );

            this.webrtcConnections[otherId] = newConn;
            newConn.connect();
        }
    }

    class WebRTCConnection {
        constructor(sendSignallingMessageImpl, cameraVisCoordinator, ws, audioStream, consumerId, providerId) {
            this.sendSignallingMessageImpl = sendSignallingMessageImpl;
            this.cameraVisCoordinator = cameraVisCoordinator;
            this.ws = ws;
            this.consumerId = consumerId;
            this.providerId = providerId;
            this.audioStream = audioStream;
            this.offered = false;

            this.receiveChannel = null;
            this.localConnection = null;

            this.onSignallingMessage = this.onSignallingMessage.bind(this);

            this.onReceiveChannelStatusChange =
                this.onReceiveChannelStatusChange.bind(this);
            this.onReceiveChannelMessage =
                this.onReceiveChannelMessage.bind(this);
            this.onSendChannelStatusChange =
                this.onSendChannelStatusChange.bind(this);
            this.onWebRTCError =
                this.onWebRTCError.bind(this);
        }

        async onSignallingMessage(msg) {
            if (msg.command === 'newIceCandidate') {
                if (DEBUG) {
                    console.log('webrtc remote candidate', msg);
                }
                this.localConnection.addIceCandidate(msg.candidate)
                    .catch(this.onWebRTCError);
                return;
            }

            if (msg.command === 'newDescription') {
                try {
                    await this.localConnection.setRemoteDescription(msg.description);
                    if (!this.offered) {
                        let answer = await this.localConnection.createAnswer();
                        await this.localConnection.setLocalDescription(answer);
                        this.sendSignallingMessage({
                            src: this.consumerId,
                            dest: this.providerId,
                            command: 'newDescription',
                            description: this.localConnection.localDescription,
                        });
                    }
                } catch (e) {
                    // This error only occurs as a result of older WebRTC implementations
                    if (this.localConnection.signalingState === 'stable' && e.name === 'InvalidStateError') {
                        console.warn('setRemoteDescription error', e);
                        return;
                    }
                    this.onWebRTCError(e);
                }
            }
        }

        initLocalConnection() {
            this.localConnection = new RTCPeerConnection({
                iceServers: iceServers,
            });

            this.localConnection.addEventListener('icecandidate', (e) => {
                if (DEBUG) {
                    console.log('webrtc local candidate', e);
                }

                if (!e.candidate) {
                    return;
                }

                this.sendSignallingMessage({
                    src: this.consumerId,
                    dest: this.providerId,
                    command: 'newIceCandidate',
                    candidate: e.candidate,
                });
            });

            this.localConnection.addEventListener('datachannel', (e) => {
                if (DEBUG) {
                    console.log('webrtc datachannel', e);
                }

                this.sendChannel = e.channel;
                this.sendChannel.addEventListener('open', this.onSendChannelStatusChange);
                this.sendChannel.addEventListener('close', this.onSendChannelStatusChange);
            });

            this.localConnection.addEventListener('track', (e) => {
                if (DEBUG) {
                    console.log('webrtc track event', e);
                }

                if (e.streams.length === 0) {
                    return;
                }
                const elt = document.createElement('video');
                // elt.style.position = 'absolute';
                // elt.style.top = 0;
                // elt.style.left = 0;
                // elt.style.zIndex = 10000;
                // elt.style.transform = 'translateZ(10000px)';
                // elt.controls = true;

                elt.autoplay = true;
                elt.srcObject = e.streams[0];
                let timesFailed = 0;
                let autoplayWhenAvailableInterval = setInterval(() => {
                    try {
                        elt.play();
                    } catch (err) {
                        if (DEBUG) {
                            console.log('autoplay failed', err);
                        }
                        timesFailed += 1;
                        // this is a delay of 3000 ms = 250 ms * 12 so that
                        // notifications don't overlap but stay on screen for a
                        // decent amount of time
                        if (timesFailed > 12) {
                            showError(ErrorMessage.autoplayBlocked, err, 'autoplayErrorUI', 'autoplayErrorText', 12 * 250);
                            timesFailed = 0;
                        }
                    }
                }, 250);
                elt.addEventListener('play', function clearAutoplayInterval() {
                    clearInterval(autoplayWhenAvailableInterval);
                    elt.removeEventListener('play', clearAutoplayInterval);
                });
                document.body.appendChild(elt);
            });

            this.receiveChannel = this.localConnection.createDataChannel(
                'sendChannel',
                {
                    ordered: false,
                    maxRetransmits: 0,
                },
            );
            this.receiveChannel.binaryType = 'arraybuffer';
            this.receiveChannel.onopen = this.onReceiveChannelStatusChange;
            this.receiveChannel.onclose = this.onReceiveChannelStatusChange;
            this.receiveChannel.addEventListener('message', this.onReceiveChannelMessage);

            if (this.audioStream) {
                this.localConnection.addStream(this.audioStream);
            } else {
                console.warn('missing audiostream');
            }
        }

        async connect() {
            if (!this.localConnection) {
                this.initLocalConnection();
            }

            this.offered = true;
            const offer = await this.localConnection.createOffer({
                offerToReceiveAudio: true,
                offerToReceiveVideo: true,
            });
            await this.localConnection.setLocalDescription(offer);

            this.sendSignallingMessage({
                src: this.consumerId,
                dest: this.providerId,
                command: 'newDescription',
                description: this.localConnection.localDescription,
            });
        }

        sendSignallingMessage(message) {
            this.sendSignallingMessageImpl(message);
        }

        onSendChannelStatusChange() {
            if (!this.sendChannel) {
                return;
            }

            const state = this.sendChannel.readyState;
            if (DEBUG) {
                console.log('webrtc onSendChannelStatusChange', state);
            }
        }

        onReceiveChannelStatusChange() {
            if (!this.receiveChannel) {
                return;
            }

            const state = this.receiveChannel.readyState;
            if (DEBUG) {
                console.log('webrtc onReceiveChannelStatusChange', state);
            }

            if (state === 'open') {
                // create cameravis with receiveChannel
            }
        }

        async onReceiveChannelMessage(event) {
            const id = this.providerId;
            let bytes = event.data;
            if (bytes instanceof ArrayBuffer) {
                bytes = new Uint8Array(event.data);
            }
            if (bytes.length === 0) {
                return;
            }

            if (bytes.length < 1000) {
                // const decoder = new TextDecoder();
                const matricesMsg = decoder.decode(bytes);
                // blah blah it's matrix
                const matrices = JSON.parse(matricesMsg);
                this.onMatrices(id, matrices);
                return;
            }

            if (DEPTH_REPR_FORCE_PNG) {
                switch (bytes[0]) {
                    case 0xff: {
                        const imageUrl = URL.createObjectURL(new Blob([event.data], { type: 'image/jpeg' }));
                        // Color is always JPEG which has first byte 0xff
                        this.cameraVisCoordinator.renderPointCloud(id, 'texture', imageUrl);
                    }
                        break;

                    case 0x89: {
                        const imageUrl = URL.createObjectURL(new Blob([event.data], { type: 'image/png' }));
                        // Depth is always PNG which has first byte 0x89
                        this.cameraVisCoordinator.renderPointCloud(id, 'textureDepth', imageUrl);
                    }
                        break;
                }
            } else {
                // jpeg start of image, chance of this happening from rvl is probably 0 but at most 1/(1 << 16)
                if (bytes[0] === 0xff && bytes[1] === 0xd8) {
                    const imageUrl = URL.createObjectURL(new Blob([event.data], { type: 'image/jpeg' }));
                    // Color is always JPEG which has first byte 0xff
                    this.cameraVisCoordinator.renderPointCloud(id, 'texture', imageUrl);
                    // PNG header for depth just in case
                } else if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
                    const imageUrl = URL.createObjectURL(new Blob([event.data], { type: 'image/png' }));
                    this.cameraVisCoordinator.renderPointCloud(id, 'textureDepth', imageUrl);
                } else {
                    // if (!window.timings) {
                    //     window.timings = {
                    //         parseFrame: [],
                    //         parseDepth: [],
                    //         parseMats: [],
                    //         doMats: [],
                    //         doDepth: [],
                    //     };
                    // }
                    // let start = window.performance.now();
                    const parser = new RVLParser(bytes.buffer);
                    // let parseFrame = window.performance.now();
                    const rawDepth = parser.getFrameRawDepth(parser.currentFrame);
                    // let parseDepth = window.performance.now();
                    const matricesMsg = decoder.decode(parser.currentFrame.payload);
                    const matrices = JSON.parse(matricesMsg);
                    // let parseMats = window.performance.now();
                    this.onMatrices(id, matrices);
                    // let doMats = window.performance.now();
                    if (!rawDepth) {
                        console.warn('RVL depth unparsed');
                        return;
                    }
                    this.cameraVisCoordinator.renderPointCloudRawDepth(id, rawDepth);
                    // let doDepth = window.performance.now();
                    // window.timings.parseFrame.push(parseFrame - start);
                    // window.timings.parseDepth.push(parseDepth - parseFrame);
                    // window.timings.parseMats.push(parseMats - parseDepth);
                    // window.timings.doMats.push(doMats - parseMats);
                    // window.timings.doDepth.push(doDepth - doMats);
                }
            }
        }

        onMatrices(id, matrices) {
            let cameraNode = new realityEditor.sceneGraph.SceneNode(id + '-camera');
            cameraNode.setLocalMatrix(matrices.camera);
            cameraNode.updateWorldMatrix();

            let gpNode = new realityEditor.sceneGraph.SceneNode(id + '-gp');
            gpNode.needsRotateX = true;
            let gpRxNode = new realityEditor.sceneGraph.SceneNode(id + '-gp' + 'rotateX');
            gpRxNode.addTag('rotateX');
            gpRxNode.setParent(gpNode);

            const c = Math.cos(-Math.PI / 2);
            const s = Math.sin(-Math.PI / 2);
            let rxMat = [
                1, 0, 0, 0,
                0, c, -s, 0,
                0, s, c, 0,
                0, 0, 0, 1
            ];
            gpRxNode.setLocalMatrix(rxMat);

            // let gpNode = realityEditor.sceneGraph.getSceneNodeById(
            //     realityEditor.sceneGraph.NAMES.GROUNDPLANE + realityEditor.sceneGraph.TAGS.ROTATE_X);
            // if (!gpNode) {
            //     gpNode = realityEditor.sceneGraph.getSceneNodeById(realityEditor.sceneGraph.NAMES.GROUNDPLANE);
            // }
            gpNode.setLocalMatrix(matrices.groundplane);
            gpNode.updateWorldMatrix();
            // gpRxNode.updateWorldMatrix();

            let sceneNode = new realityEditor.sceneGraph.SceneNode(id);
            sceneNode.setParent(realityEditor.sceneGraph.getSceneNodeById('ROOT'));

            let initialVehicleMatrix = [
                -1, 0, 0, 0,
                0, 1, 0, 0,
                0, 0, -1, 0,
                0, 0, 0, 1,
            ];

            sceneNode.setPositionRelativeTo(cameraNode, initialVehicleMatrix);
            sceneNode.updateWorldMatrix();

            let cameraMat = sceneNode.getMatrixRelativeTo(gpRxNode);
            this.cameraVisCoordinator.updateMatrix(id, new Float32Array(cameraMat), false, matrices);
        }

        onWebRTCError(e) {
            console.error('webrtc error', e);
            showError(ErrorMessage.webrtcIssue, e, 'webRTCErrorUI', 'webRTCErrorText', 5000);
        }

        disconnect() {
            this.sendSignallingMessage({
                src: this.consumerId,
                dest: this.providerId,
                command: 'leaveNetwork',
            });

            this.sendChannel.close();
            this.receiveChannel.close();

            this.localConnection.close();

            this.sendChannel = null;
            this.receiveChannel = null;
            this.localConnection = null;
        }
    }

    exports.WebRTCCoordinator = WebRTCCoordinator;
})(realityEditor.device.cameraVis);

