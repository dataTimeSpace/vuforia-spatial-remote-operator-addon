const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const VideoLib = require('node-video-lib');

// TODO: write pose matrices so they can be cross-referenced with the video stream
// TODO: listen to when the ffmpeg process fully finishes writing data to disk, so that process can be killed/freed/etc

// TODO: cleanup the whole pipeline so we don't end up in broken states

class VideoServer {
    constructor(outputPath) {
        this.outputPath = outputPath;
        this.PROCESS = Object.freeze({
            COLOR: 'COLOR',
            DEPTH: 'DEPTH'
        });
        this.STATUS = Object.freeze({
            NOT_STARTED: 'NOT_STARTED',
            STARTED: 'STARTED',
            ENDING: 'ENDING',
            ENDED: 'ENDED'
        });
        this.DIR_NAMES = Object.freeze({
            unprocessed_chunks: 'unprocessed_chunks',
            processed_chunks: 'processed_chunks',
            session_videos: 'session_videos'
        });
        this.processes = {};
        this.processStatuses = {};
        this.SEGMENT_LENGTH = 15000;
        this.isRecording = {}; // boolean for each deviceId
        this.anythingReceived = {}; // boolean for each deviceId
        this.DEBUG_WRITE_IMAGES = false;
        this.sessionId = this.uuidTimeShort(); // each time the server restarts, tag videos from this instance with a unique ID

        if (!fs.existsSync(this.outputPath)) {
            fs.mkdirSync(this.outputPath, {recursive: true});
            console.log('Created directory for VideoServer outputPath: ' + this.outputPath);
        }

        console.log('Created a VideoServer with path: ' + this.outputPath);

        this.persistentInfo = this.loadPersistentInfo();
        // this.checkPersistentInfoIntegrity(); // TODO: reimplement this with new file structure

        // for each deviceId in persistentInfo
        // this.concatExisting(); // TODO: reimplement with new file structure

        // every 10s, check if any newly recorded videos need to be processed
        // setInterval(() => {
        //     this.evaluateAndRescaleVideosIfNeeded();
        // }, 10000);
        // this.evaluateAndRescaleVideosIfNeeded();

        Object.keys(this.persistentInfo).forEach(deviceId => {
            this.concatExisting(deviceId);
        });

        Object.keys(this.persistentInfo).forEach(deviceId => {
            this.evaluateAndRescaleVideosIfNeeded(deviceId);
        });
    }
    loadPersistentInfo() {
        let jsonPath = path.join(this.outputPath, 'videoInfo.json');
        let defaultInfo = {};
        if (!fs.existsSync(jsonPath)) {
            fs.writeFileSync(jsonPath, JSON.stringify(defaultInfo, null, 4));
            return defaultInfo;
        } else {
            return JSON.parse(fs.readFileSync(jsonPath, { encoding: 'utf8', flag: 'r' }));
        }
    }
    checkPersistentInfoIntegrity() {
        // ensure that none of the concatenated video files listed in the json file have been deleted
        let deletedVideos = [];
        let anyChanges = false;
        Object.keys(this.persistentInfo.mergedFiles.color).forEach(filePath => {
            if (!fs.existsSync(filePath)) {
                deletedVideos.push(filePath);
                anyChanges = true;
                console.log('video file was deleted: ' + filePath);
            }
        });
        deletedVideos.forEach(filePath => {
            delete this.persistentInfo.mergedFiles.color[filePath];
        });

        deletedVideos = [];
        Object.keys(this.persistentInfo.mergedFiles.depth).forEach(filePath => {
            if (!fs.existsSync(filePath)) {
                deletedVideos.push(filePath);
                anyChanges = true;
                console.log('video file was deleted: ' + filePath);
            }
        });
        deletedVideos.forEach(filePath => {
            delete this.persistentInfo.mergedFiles.depth[filePath];
        });

        if (anyChanges) { this.savePersistentInfo(); }
    }
    concatExisting(deviceId) {
        if (!fs.existsSync(path.join(this.outputPath, deviceId))) {
            console.log('concat, dir doesnt exist', path.join(this.outputPath, deviceId));
            return;
        }

        let sessions = {}; // extract list of session uuids from chunk filenames

        let colorChunks = this.getProcessedChunkFilePaths(deviceId, 'color');
        let depthChunks = this.getProcessedChunkFilePaths(deviceId, 'depth');
        let colorSessions = this.getSessionFilePaths(deviceId, 'color');
        let depthSessions = this.getSessionFilePaths(deviceId, 'depth');

        colorChunks.forEach(filepath => { // e.g. chunk_Dw7jlxox_1643398707456.mp4 -> Dw7jlxox
            let sessionId = filepath.match(/chunk_[a-zA-Z0-9]{8}/)[0].replace('chunk_', '');
            if (typeof sessions[sessionId] === 'undefined') {
                sessions[sessionId] = {
                    colorChunks: [],
                    depthChunks: [],
                    finalColorVideo: null,
                    finalDepthVideo: null
                };
            }
            sessions[sessionId].colorChunks.push(filepath);
        });

        depthChunks.forEach(filepath => {
            let sessionId = filepath.match(/chunk_[a-zA-Z0-9]{8}/)[0].replace('chunk_', '');
            if (typeof sessions[sessionId] === 'undefined') {
                sessions[sessionId] = {
                    colorChunks: [],
                    depthChunks: [],
                    finalColorVideo: null,
                    finalDepthVideo: null
                };
            }
            sessions[sessionId].depthChunks.push(filepath);
        });

        colorSessions.forEach(filepath => {
            let sessionId = filepath.match(/session_[a-zA-Z0-9]{8}/)[0].replace('session_', '');
            if (typeof sessions[sessionId] === 'undefined') {
                sessions[sessionId] = {
                    colorChunks: [],
                    depthChunks: [],
                    finalColorVideo: null,
                    finalDepthVideo: null
                };
            }
            sessions[sessionId].finalColorVideo = filepath;
        });

        depthSessions.forEach(filepath => {
            let sessionId = filepath.match(/session_[a-zA-Z0-9]{8}/)[0].replace('session_', '');
            if (typeof sessions[sessionId] === 'undefined') {
                sessions[sessionId] = {
                    colorChunks: [],
                    depthChunks: [],
                    finalColorVideo: null,
                    finalDepthVideo: null
                };
            }
            sessions[sessionId].finalDepthVideo = filepath;
        });

        console.log('parsed sessions for ' + deviceId + ':', sessions);

        Object.keys(sessions).forEach(sessionId => {
            if (sessions[sessionId].finalColorVideo && sessions[sessionId].finalDepthVideo) { return; }

            let thisSession = sessions[sessionId];
            if (!thisSession.finalColorVideo && thisSession.colorChunks.length > 0) {
                let outputFilePath = this.concatFiles(deviceId, sessionId, 'color', thisSession.colorChunks);
                let timeInfo = this.extractTimeInformation(thisSession.colorChunks);
                console.log('merged color chunks, got time info', outputFilePath, timeInfo);
                // // TODO: don't write absolutePath of mergedColorFilePath to the json file, write relative path
                // this.persistentInfo.mergedFiles.color[mergedColorFilePath] = {
                //     fileList: colorFiles, // colorFiles.map(filename => path.join(this.outputPath, filename));
                //     startTime: timeInfo.start,
                //     endTime: timeInfo.end,
                //     duration: timeInfo.duration
                // };
            }

            if (!thisSession.finalDepthVideo && thisSession.depthChunks.length > 0) {
                let outputFilePath = this.concatFiles(deviceId, sessionId, 'depth', thisSession.depthChunks);
                let timeInfo = this.extractTimeInformation(thisSession.depthChunks);
                console.log('merged depth chunks, got time info', outputFilePath, timeInfo);
                // // TODO: don't write absolutePath of mergedColorFilePath to the json file, write relative path
                // this.persistentInfo.mergedFiles.color[mergedColorFilePath] = {
                //     fileList: colorFiles, // colorFiles.map(filename => path.join(this.outputPath, filename));
                //     startTime: timeInfo.start,
                //     endTime: timeInfo.end,
                //     duration: timeInfo.duration
                // };
            }
        });

        // if (anyChanges) {
        //     console.log('new videos were concatenated');
        //     this.savePersistentInfo();
        // } else {
        //     console.log('no new videos needed to be concatenated');
        // }
    }
    extractTimeInformation(fileList) {
        let fileRecordingTimes = fileList.map(filename => parseInt(filename.match(/[0-9]{13,}/))); // extract timestamp
        let firstTimestamp = Math.min(...fileRecordingTimes) - this.SEGMENT_LENGTH; // estimate, since this is at the end of the first video
        let lastTimestamp = Math.max(...fileRecordingTimes);
        return {
            start: firstTimestamp,
            end: lastTimestamp,
            duration: lastTimestamp - firstTimestamp
        };
    }
    savePersistentInfo() {
        let jsonPath = path.join(this.outputPath, 'videoInfo.json');
        fs.writeFileSync(jsonPath, JSON.stringify(this.persistentInfo, null, 4));
        console.log('saved videoInfo');
    }
    concatFiles(deviceId, sessionId, colorOrDepth = 'color', files) {
        let fileText = '';
        for (let i = 0; i < files.length; i++) {
            fileText += 'file \'' + path.join(this.outputPath, deviceId, this.DIR_NAMES.processed_chunks, colorOrDepth, files[i]) + '\'\n';
        }

        // write file list to txt file so it can be used by ffmpeg as input
        let txt_filename = colorOrDepth + '_filenames_' + sessionId + '.txt';
        let txtFilePath = path.join(this.outputPath, deviceId, txt_filename);
        if (fs.existsSync(txtFilePath)) {
            fs.unlinkSync(txtFilePath);
        }
        fs.writeFileSync(txtFilePath, fileText);

        let filename = 'device_' + deviceId + '_session_' + sessionId + '.mp4'; // path.join(this.outputPath, output_name + '_' + timestamp + '.mp4');
        let outputPath = path.join(this.outputPath, deviceId, this.DIR_NAMES.session_videos, colorOrDepth, filename);
        this.ffmpeg_concat_mp4s(outputPath, txtFilePath);
        return outputPath;
    }
    startRecording(deviceId) {
        this.isRecording[deviceId] = true;
        this.processes[deviceId] = {};
        this.processStatuses[deviceId] = {};

        if (!fs.existsSync(path.join(this.outputPath, deviceId))) {
            fs.mkdirSync(path.join(this.outputPath, deviceId, this.DIR_NAMES.unprocessed_chunks, 'color'), { recursive: true });
            fs.mkdirSync(path.join(this.outputPath, deviceId, this.DIR_NAMES.unprocessed_chunks, 'depth'), { recursive: true });
            fs.mkdirSync(path.join(this.outputPath, deviceId, this.DIR_NAMES.processed_chunks, 'color'), { recursive: true });
            fs.mkdirSync(path.join(this.outputPath, deviceId, this.DIR_NAMES.processed_chunks, 'depth'), { recursive: true });
            fs.mkdirSync(path.join(this.outputPath, deviceId, this.DIR_NAMES.session_videos, 'color'), { recursive: true });
            fs.mkdirSync(path.join(this.outputPath, deviceId, this.DIR_NAMES.session_videos, 'depth'), { recursive: true });
        }

        if (typeof this.persistentInfo[deviceId] === 'undefined') {
            this.persistentInfo[deviceId] = {
                mergedFiles: {
                    color: {},
                    depth: {}
                }
            };
            this.savePersistentInfo();
        }

        // start color stream process
        // depth images are 1920x1080 lossy JPG images
        let chunkTimestamp = Date.now();
        let colorOutputPath = path.join(this.outputPath, deviceId, this.DIR_NAMES.unprocessed_chunks, 'color', 'chunk_' + this.sessionId + '_' + chunkTimestamp + '.mp4');
        this.processes[deviceId][this.PROCESS.COLOR] = this.ffmpeg_image2mp4(colorOutputPath, 10, 'mjpeg', 1920, 1080, 25, 0.5);
        if (this.processes[deviceId][this.PROCESS.COLOR]) {
            this.processStatuses[deviceId][this.PROCESS.COLOR] = this.STATUS.STARTED;
        }

        // start depth stream process
        // depth images are 256x144 lossless PNG buffers
        let depthOutputPath = path.join(this.outputPath, deviceId, this.DIR_NAMES.unprocessed_chunks, 'depth', 'chunk_' + this.sessionId + '_' + chunkTimestamp + '.mp4');
        this.processes[deviceId][this.PROCESS.DEPTH] = this.ffmpeg_image2mp4(depthOutputPath, 10, 'png', 256, 144, 25, 1);
        if (this.processes[deviceId][this.PROCESS.DEPTH]) {
            this.processStatuses[deviceId][this.PROCESS.DEPTH] = this.STATUS.STARTED;
        }

        setTimeout(function() {
            this.stopRecording(deviceId);
            setTimeout(function() {
                this.startRecording(deviceId);
            }.bind(this), 100);
        }.bind(this), this.SEGMENT_LENGTH);
    }
    stopRecording(deviceId) {
        this.isRecording[deviceId] = false;

        let colorProcess = this.processes[deviceId][this.PROCESS.COLOR];
        let depthProcess = this.processes[deviceId][this.PROCESS.DEPTH];
        let colorStatus = this.processStatuses[deviceId][this.PROCESS.COLOR];
        let depthStatus = this.processStatuses[deviceId][this.PROCESS.DEPTH];

        if (colorProcess !== 'undefined' && colorStatus === this.STATUS.STARTED) {
            console.log('end color process');
            colorProcess.stdin.setEncoding('utf8');
            colorProcess.stdin.write('q');
            colorProcess.stdin.end();
            colorStatus = this.STATUS.ENDING;
        }

        if (depthProcess !== 'undefined' && depthStatus === this.STATUS.STARTED) {
            console.log('end depth process');
            depthProcess.stdin.setEncoding('utf8');
            depthProcess.stdin.write('q');
            depthProcess.stdin.end();
            depthStatus = this.STATUS.ENDING;
        }
    }
    onFrame(rgb, depth, _pose, deviceId) {
        if (!this.anythingReceived[deviceId]) {
            this.startRecording(deviceId); // start recording the first time it receives a data packet
            this.anythingReceived[deviceId] = true;
        }
        if (!this.isRecording[deviceId]) {
            return;
        }

        let colorProcess = this.processes[deviceId][this.PROCESS.COLOR];
        let depthProcess = this.processes[deviceId][this.PROCESS.DEPTH];
        let colorStatus = this.processStatuses[deviceId][this.PROCESS.COLOR];
        let depthStatus = this.processStatuses[deviceId][this.PROCESS.DEPTH];

        if (typeof colorProcess !== 'undefined' && colorStatus === 'STARTED') {
            colorProcess.stdin.write(rgb);
        }

        if (typeof depthProcess !== 'undefined' && depthStatus === 'STARTED') {
            depthProcess.stdin.write(depth);
        }

        if (this.DEBUG_WRITE_IMAGES) {
            let colorFilename = 'color_' + Date.now() + '.png'; // + Math.floor(Math.random() * 1000)
            let depthFilename = 'depth_' + Date.now() + '.png';
            let imageDir = path.join(this.outputPath, deviceId, 'debug_images');
            if (!fs.existsSync(imageDir)) {
                fs.mkdirSync(imageDir, { recursive: true });
            }
            // let matrixFilename = 'matrix_' + Date.now() + '.png';
            fs.writeFile(path.join(imageDir, colorFilename), rgb, function() {
                // console.log('wrote color image');
            });

            fs.writeFile(path.join(imageDir, depthFilename), depth, function() {
                // console.log('wrote depth image');
            });

            // fs.writeFile(path.join(__dirname, 'images', 'matrix', matrixFilename), pose, function() {
            //     // console.log('wrote matrix image');
            // });
        }

    }
    // rescaleVideoLengths(files, newDuration) {
    //     console.log('need to scale files: ', files);
    //
    //     let unprocessedPath = path.join(this.outputPath, deviceId, this.DIR_NAMES.unprocessed_chunks);
    //     let processedPath = path.join(this.outputPath, deviceId, this.DIR_NAMES.processed_chunks);
    //
    //     let unprocessedColorFiles = fs.readdirSync(path.join(unprocessedPath, 'color')).filter(filename => filename.includes('.mp4'));
    //     let processedColorFiles = fs.readdirSync(path.join(processedPath, 'color')).filter(filename => filename.includes('.mp4'));
    //     let unprocessedDepthFiles = fs.readdirSync(path.join(unprocessedPath, 'depth')).filter(filename => filename.includes('.mp4'));
    //     let processedDepthFiles = fs.readdirSync(path.join(processedPath, 'depth')).filter(filename => filename.includes('.mp4'));
    //
    //     for (let i = 0; i < files.length; i++) {
    //         // let outputPath = 
    //         this.ffmpeg_adjust_length(files[i].replace('stream', 'resized'), path.join(this.outputPath, files[i]), newDuration);
    //     }
    // }
    ffmpeg_adjust_length(output_path, input_path, newDuration) {
        fs.open(input_path, 'r', function(err, fd) {
            try {
                let movie = VideoLib.MovieParser.parse(fd);
                // Work with movie
                console.log('Duration:', movie.relativeDuration());

                // getVideoDurationInSeconds(input_path).then((duration) => {
                // console.log('old duration = ' + duration);

                console.log('change duration:', output_path, input_path, newDuration);
                let args = [
                    '-f', 'mp4',
                    '-i', input_path,
                    '-filter:v', 'setpts=' + newDuration / movie.relativeDuration() + '*PTS',
                    output_path
                ];
                let process = cp.spawn('ffmpeg', args);
                process.stderr.setEncoding('utf8');
                process.stderr.on('data', function(data) {
                    console.log('stderr data', data);
                });
                console.log('new file: ' + output_path);
                return output_path;
                // });
            } catch (ex) {
                console.error('Error:', ex);
            } finally {
                fs.closeSync(fd);
            }
        }.bind(this));
    }
    ffmpeg_concat_mp4s(output_path, file_list_path, timestamp) {
        // ffmpeg -f concat -safe 0 -i fileList.txt -c copy mergedVideo.mp4
        // we pass in a timestamp so we can use an identical one in the color and depth videos that match up
        let args = [
            '-f', 'concat',
            '-safe', '0',
            '-i', file_list_path,
            '-c', 'copy',
            output_path
        ];

        cp.spawn('ffmpeg', args);
    }
    ffmpeg_image2mp4(output_path, framerate = 8, input_vcodec = 'mjpeg', input_width = 1920, input_height = 1080, crf = 25, output_scale = 0.25) {
        // let filePath = path.join(this.outputPath, output_name + '_' + Date.now() + '.mp4');

        let outputWidth = input_width * output_scale;
        let outputHeight = input_height * output_scale;

        let args = [
            // '-r', framerate,
            // '-framerate', framerate,
            // '-probesize', '5000',
            // '-analyzeduration', '5000',
            '-f', 'image2pipe',
            '-vcodec', input_vcodec,
            '-s', input_width + 'x' + input_height,
            '-i', '-',
            '-vcodec', 'libx264',
            '-crf', crf,
            '-pix_fmt', 'yuv420p',
            '-vf', 'scale=' + outputWidth + ':' + outputHeight + ', setsar=1:1', //, realtime, fps=' + framerate,
            // '-preset', 'ultrafast',
            // '-copyts',
            // '-tune', 'zerolatency',
            // '-r', framerate, // will duplicate frames to meet this but still look like the framerate set before -i,
            output_path
        ];

        let process = cp.spawn('ffmpeg', args);

        // process.stdout.on('data', function(data) {
        //     console.log('stdout data', data);
        // });
        process.stderr.setEncoding('utf8');
        process.stderr.on('data', function(data) {
            console.log('stderr data', data);
        });
        // process.on('close', function() {
        //     console.log('finished');
        // });

        console.log('created child_process with args:', args);
        return process;
    }
    getUnprocessedChunkFilePaths(deviceId, colorOrDepth = 'color') {
        let unprocessedPath = path.join(this.outputPath, deviceId, this.DIR_NAMES.unprocessed_chunks);
        return fs.readdirSync(path.join(unprocessedPath, colorOrDepth)).filter(filename => filename.includes('.mp4'));
    }
    getProcessedChunkFilePaths(deviceId, colorOrDepth = 'color') {
        let processedPath = path.join(this.outputPath, deviceId, this.DIR_NAMES.processed_chunks);
        return fs.readdirSync(path.join(processedPath, colorOrDepth)).filter(filename => filename.includes('.mp4'));
    }
    getSessionFilePaths(deviceId, colorOrDepth = 'color') {
        let sessionPath = path.join(this.outputPath, deviceId, this.DIR_NAMES.session_videos);
        return fs.readdirSync(path.join(sessionPath, colorOrDepth)).filter(filename => filename.includes('.mp4'));
    }
    evaluateAndRescaleVideosIfNeeded(deviceId) {
        let unprocessedPath = path.join(this.outputPath, deviceId, this.DIR_NAMES.unprocessed_chunks);
        let processedPath = path.join(this.outputPath, deviceId, this.DIR_NAMES.processed_chunks);

        let unprocessedColorFiles = this.getUnprocessedChunkFilePaths(deviceId, 'color');
        let processedColorFiles = this.getProcessedChunkFilePaths(deviceId, 'color');
        let unprocessedDepthFiles = this.getUnprocessedChunkFilePaths(deviceId, 'depth');
        let processedDepthFiles = this.getProcessedChunkFilePaths(deviceId, 'depth');

        // let allPreviouslyMergedColorStreams = Object.values(this.persistentInfo.mergedFiles.color).reduce((a, b) => a.concat(b.fileList), []);
        // let allPreviouslyMergedDepthStreams = Object.values(this.persistentInfo.mergedFiles.depth).reduce((a, b) => a.concat(b.fileList), []);

        // remove files that have already been merged
        // colorFiles = colorFiles.filter(filename => !allPreviouslyMergedColorStreams.includes(filename));
        // depthFiles = depthFiles.filter(filename => !allPreviouslyMergedDepthStreams.includes(filename));

        // for each file, check if a _resized_ file already exists, and delete _stream_ if so – otherwise create _resized_
        let filesToScale = [];
        unprocessedColorFiles.forEach(filename => {
            let alreadyScaled = false;
            let timestamp = filename.match(/[0-9]{13,}/);
            processedColorFiles.forEach(resizedFilename => {
                if (resizedFilename.includes(timestamp)) {
                    // delete the colorStreamFile
                    alreadyScaled = true;
                }
            });
            if (alreadyScaled) {
                // console.log('delete color file: ' + filename);
                // fs.rmSync(path.join(this.outputPath, filename));
            } else {
                filesToScale.push(filename);
            }
        });
        if (filesToScale.length > 0) {
            // this.rescaleVideoLengths(filesToScale, 30.0);

            for (let i = 0; i < filesToScale.length; i++) {
                let inputPath = path.join(unprocessedPath, 'color', filesToScale[i]);
                let outputPath = path.join(processedPath, 'color', filesToScale[i]);
                this.ffmpeg_adjust_length(outputPath, inputPath, this.SEGMENT_LENGTH / 1000);
            }
        }

        filesToScale = [];
        unprocessedDepthFiles.forEach(filename => {
            let alreadyScaled = false;
            let timestamp = filename.match(/[0-9]{13,}/);
            processedDepthFiles.forEach(resizedFilename => {
                if (resizedFilename.includes(timestamp)) {
                    // delete the colorStreamFile
                    alreadyScaled = true;
                }
            });
            if (alreadyScaled) {
                // console.log('delete depth file: ' + filename);
                // fs.rmSync(path.join(this.outputPath, filename));
            } else {
                filesToScale.push(filename);
            }
        });
        if (filesToScale.length > 0) {
            // this.rescaleVideoLengths(filesToScale, 30.0);

            for (let i = 0; i < filesToScale.length; i++) {
                let inputPath = path.join(unprocessedPath, 'depth', filesToScale[i]);
                let outputPath = path.join(processedPath, 'depth', filesToScale[i]);
                this.ffmpeg_adjust_length(outputPath, inputPath, this.SEGMENT_LENGTH / 1000);
            }
        }

        // if (colorFiles.length > 0) {
        //     this.rescaleVideoLengths(colorFiles, 30.0);
        // }
        // if (depthFiles.length > 0) {
        //     this.rescaleVideoLengths(depthFiles, 30.0);
        // }
    }
    /**
     * Generates a random 8 character unique identifier using uppercase, lowercase, and numbers (e.g. "jzY3y338")
     * @return {string}
     */
    uuidTimeShort() {
        var dateUuidTime = new Date();
        var abcUuidTime = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        var stampUuidTime = parseInt('' + dateUuidTime.getMilliseconds() + dateUuidTime.getMinutes() + dateUuidTime.getHours() + dateUuidTime.getDay()).toString(36);
        while (stampUuidTime.length < 8) stampUuidTime = abcUuidTime.charAt(Math.floor(Math.random() * abcUuidTime.length)) + stampUuidTime;
        return stampUuidTime;
    }
}

module.exports = VideoServer;
