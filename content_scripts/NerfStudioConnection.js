createNameSpace('realityEditor.device');


(function (exports) {

const NERF_STUDIO_WEBSOCKET_URL = 'ws://localhost:7007';
const DEBUG_CAMERA_MESSAGE = true;

class NerfStudioConnection {
    constructor() {
        this.isEnabled = false;
        this.websocket = null;
        this.peerConnection = {};
    }

    // turn on to create a new websocket for the camera messages, and a new RTCPeerConnection for the images
    turnOn() {
        this.isEnabled = true;
        this.connect();
    }

    // turn off to stop sending camera messages over the websocket
    turnOff() {
        this.isEnabled = false;
    }

    // runs the first time you turnOn - creates the websocket and webrtc connection
    connect() {
        if (this.websocket) return;

        // I think we need to use a standard WebSocket, because socket.io can't send messages encoded by msgpack in the format nerfstudio expects
        this.websocket = new WebSocket(NERF_STUDIO_WEBSOCKET_URL);

        this.websocket.onopen = (e => {
            console.log('opened connection to nerf studio');
            // we can only establish the webrtc connection after the websocket is ready
            this.establishWebRTCConnection();
        });

        this.websocket.onclose = (e => {
            console.log('closed connection to nerf studio');
        });

        this.websocket.onerror = (e => {
            console.error('error with nerfstudio websocket', e);
        });
    }

    // this will send a message that will trigger the nerfstudio/viewer/server/server.py, line 52 (on_message)
    sendCameraToNerfStudio(cameraMatrix) {
        if (!this.isEnabled) return;
        if (!this.websocket) {
            console.log('cannot send message, nerf websocket not initialized');
            return;
        }
        if (this.websocket.readyState !== 1) {
            console.log('websocket readyState is not CONNECTED');
            return;
        }

        // this is a value of the camera taken from the nerfstudio viewer, can be used as reference.
        // it makes me think that the units are meters, not mm, so scale the cameraMatrix translation
        //   values down by 1000 before passing into this function.
        let defaultMatrix = [
            0.8768288709363371, -0.48080259056343316, 0, 0,
            0.3139440447617337, 0.5725326936841874, 0.7573938548875155, 0,
            -0.36415692750674244, -0.6641047986351402, 0.6529583053906498, 0,
            -0.4129898476856783, -0.7473400792058696, 0.6822817432737595, 1
        ];

        let message = {
            type: 'write', //'toolbox', // the server switches thru type to handle the message differently
            path: 'renderingState/camera', // the server applies the data to the object specified by this path
            data: {
                metadata: {
                    "version": 4.5,
                    "type": "Object",
                    "generator": "Object3D.toJSON"
                },
                object: {
                    "uuid": "15a0a777-f847-40e6-be32-46ce6af1d19d",
                    "type": "PerspectiveCamera",
                    "layers": 1,
                    "matrix": (cameraMatrix || defaultMatrix),
                    "fov": 50, // todo: calculate correct value
                    "zoom": 1, // todo: calculate correct value
                    "near": 0.1, // todo: calculate correct value
                    "far": 1000, // todo: calculate correct value
                    "focus": 10,
                    "aspect": 0.5714285714285714, // todo: calculate correct value
                    "filmGauge": 35,
                    "filmOffset": 0,
                    "timestamp": Date.now(), //1674073427950,
                    "camera_type": "perspective",
                    "render_aspect": 1.7777777777777777 // todo: calculate correct value
                }
            }
        };
        
        if (DEBUG_CAMERA_MESSAGE) {
            console.log('send message to nerf studio', message);
        }

        // TODO: do we also need to send to path: 'renderingState/camera_choice'
        const encodedMessage = msgpack.encode(message);
        this.websocket.send(encodedMessage);
    }

    establishWebRTCConnection() {
        console.log('establishWebRTCConnection');

        this.peerConnection.current = this.getRTCPeerConnection((dispatchedResult) => {
            console.log('[webrtc] dispatched', dispatchedResult);
        });

        console.log('[webrtc] starting process');
        
        this.sendOffer();

        this.websocket.addEventListener('message', (originalCmd) => {
            try {
                let dataByteArray = new Uint8Array(originalCmd.data);
                if (dataByteArray.byteLength === 0) {
                    console.log( ' [ websocket ] skip empty byte array');
                    return;
                }

                console.log(' [ websocket ] ', originalCmd);

                // set the remote description when the offer is received
                const cmd = msgpack.decode(dataByteArray);
                if (cmd.path === '/webrtc/answer') {
                console.log('[webrtc] received answer');
                const answer = cmd.data;
                console.log(answer);
                if (answer !== null) {
                    this.peerConnection.current.setRemoteDescription(answer);
                }
                }
            } catch (err) {
                console.warn(err);
            }
        });
    }

    getRTCPeerConnection(dispatch) {
        console.log('getRTCPeerConnection');

        const pc = new RTCPeerConnection({
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            {
            urls: 'stun:openrelay.metered.ca:80',
            },
            {
            urls: 'turn:openrelay.metered.ca:80',
            username: 'openrelayproject',
            credential: 'openrelayproject',
            },
            {
            urls: 'turn:openrelay.metered.ca:443',
            username: 'openrelayproject',
            credential: 'openrelayproject',
            },
            {
            urls: 'turn:openrelay.metered.ca:443?transport=tcp',
            username: 'openrelayproject',
            credential: 'openrelayproject',
            },
        ],
        });
        // connect video
        pc.addEventListener('track', (evt) => {
        if (evt.track.kind === 'video') {
            [localVideoRef.current.srcObject] = evt.streams; // uses array destructuring
        }
        });
        pc.addTransceiver('video', { direction: 'recvonly' });

        // for updating the status of the peer connection
        pc.oniceconnectionstatechange = () => {
        // https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/connectionState
        console.log(`[webrtc] connectionState: ${pc.connectionState}`);
        if (
            pc.connectionState === 'connecting' ||
            pc.connectionState === 'connected'
        ) {
            console.log('[webrtc] connected');
            dispatch({
            type: 'write',
            path: 'webrtcState/isConnected',
            data: true,
            });
        } else {
            dispatch({
            type: 'write',
            path: 'webrtcState/isConnected',
            data: false,
            });
        }
        };

        pc.onclose = () => {
        dispatch({
            type: 'write',
            path: 'webrtcState/isConnected',
            data: false,
        });
        };

        return pc;
    }

    sendOffer() {
        this.peerConnection.current.createOffer().then((offer) => {
            console.log('[webrtc] created offer');
            console.log(offer);
            return this.peerConnection.current.setLocalDescription(offer);
        })
        .then(() => {
            // wait for ICE gathering to complete
            console.log('[webrtc] set local description');
            return new Promise((resolve) => {
                if (this.peerConnection.current.iceGatheringState === 'complete') {
                console.log('[webrtc] ICE gathering complete');
                resolve();
                } else {
                const checkState = () => {
                    console.log(
                    `[webrtc] iceGatheringState: ${this.peerConnection.current.iceGatheringState}`,
                    );
                    if (this.peerConnection.current.iceGatheringState === 'complete') {
                    this.peerConnection.current.removeEventListener(
                        'icegatheringstatechange',
                        checkState,
                    );
                    resolve();
                    }
                };
                console.log(
                    '[webrtc] adding listener for `icegatheringstatechange`',
                );
                this.peerConnection.current.addEventListener(
                    'icegatheringstatechange',
                    checkState,
                );
                }
            });
        })
        .then(() => {
            // send the offer
            console.log('[webrtc] sending offer');
            const offer = this.peerConnection.current.localDescription;
            const cmd = 'write';
            const path = 'webrtc/offer';
            const data = {
                type: cmd,
                path,
                data: {
                sdp: offer.sdp,
                type: offer.type,
                },
            };
            const message = msgpack.encode(data);
            this.websocket.send(message);
        });
    };
}

exports.NerfStudioConnection = NerfStudioConnection;

})(realityEditor.device);
