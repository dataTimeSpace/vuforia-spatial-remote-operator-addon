const fs = require('fs');
const path = require('path');
const cp = require('child_process');

// TODO: write pose matrices so they can be cross-referenced with the video stream
// TODO: include unique per-device id in video filename so images from the same device are separated from other devices
// TODO: on server startup, try to append all contiguous video segments from previous session into a single video
// TODO: create streaming media server from which a HTML video element can stream video data
// TODO: listen to when the ffmpeg process fully finishes writing data to disk, so that process can be killed/freed/etc

class VideoServer {
    constructor(app, outputPath) {
        this.outputPath = outputPath;
        this.isRecording = false;
        this.processes = {};
        this.processStatuses = {};
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
        this.anythingReceived = false;

        if (!fs.existsSync(this.outputPath)) {
            fs.mkdirSync(this.outputPath, {recursive: true});
            console.log('Created directory for VideoServer outputPath: ' + this.outputPath);
        }

        console.log('Created a VideoServer with path: ' + this.outputPath);

        this.persistentInfo = this.loadPersistentInfo();
        this.checkPersistentInfoIntegrity();

        this.concatExisting();
        this.setupRoutes(app);
    }
    loadPersistentInfo() {
        let jsonPath = path.join(this.outputPath, 'videoInfo.json');
        let defaultInfo = {
            mergedFiles: {
                color: {},
                depth: {}
            }
        };
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
        Object.keys(this.persistentInfo.mergedFiles.color).forEach(filePath => {
            if (!fs.existsSync(filePath)) {
                deletedVideos.push(filePath);
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
                console.log('video file was deleted: ' + filePath);
            }
        });
        deletedVideos.forEach(filePath => {
            delete this.persistentInfo.mergedFiles.depth[filePath];
        });
    }
    concatExisting() {
        let files = fs.readdirSync(this.outputPath).filter(filename => filename.includes('.mp4'));
        let colorFiles = files.filter(filename => filename.includes('color_stream'));
        let depthFiles = files.filter(filename => filename.includes('depth_stream'));

        let allPreviouslyMergedColorStreams = Object.values(this.persistentInfo.mergedFiles.color).reduce((a, b) => a.concat(b), []);
        let allPreviouslyMergedDepthStreams = Object.values(this.persistentInfo.mergedFiles.depth).reduce((a, b) => a.concat(b), []);

        // remove files that have already been merged
        colorFiles = colorFiles.filter(filename => !allPreviouslyMergedColorStreams.includes(filename));
        depthFiles = depthFiles.filter(filename => !allPreviouslyMergedDepthStreams.includes(filename));

        if (colorFiles.length > 0 && depthFiles.length > 0) {
            console.log('there are videos that need to be concatenated');

            let mergedColorFilePath = this.concatFiles(colorFiles, 'color_filenames_tmp.txt', 'color_merged');
            let mergedDepthFilePath = this.concatFiles(depthFiles, 'depth_filenames_tmp.txt', 'depth_merged');

            this.persistentInfo.mergedFiles.color[mergedColorFilePath] = colorFiles; // colorFiles.map(filename => path.join(this.outputPath, filename));
            this.persistentInfo.mergedFiles.depth[mergedDepthFilePath] = depthFiles; // depthFiles.map(filename => path.join(this.outputPath, filename));
            this.savePersistentInfo();
        } else {
            console.log('no new videos need to be concatenated');
        }
    }
    savePersistentInfo() {
        let jsonPath = path.join(this.outputPath, 'videoInfo.json');
        fs.writeFileSync(jsonPath, JSON.stringify(this.persistentInfo, null, 4));
        console.log('saved videoInfo');
    }
    concatFiles(files, txt_filename, mp4_title) {
        let fileText = '';
        for (let i = 0; i < files.length; i++) {
            fileText += 'file \'' + path.join(this.outputPath, files[i]) + '\'\n';
        }

        // write file list to txt file so it can be used by ffmpeg as input
        let colorFilePath = path.join(this.outputPath, txt_filename);
        if (fs.existsSync(colorFilePath)) {
            fs.unlinkSync(colorFilePath);
        }
        fs.writeFileSync(colorFilePath, fileText);

        return this.ffmpeg_concat_mp4s(mp4_title, colorFilePath);
    }
    setupRoutes(app) {
        app.get('/videoInfo', function(req, res) {
            // let jsonPath = path.join(this.outputPath, 'videoInfo.json');
            // if (!fs.existsSync(jsonPath)) {
            //     fs.writeFileSync(jsonPath, JSON.stringify(this.persistentInfo));
            // }
            // res.sendFile(jsonPath);
            res.json(this.persistentInfo);
        }.bind(this));
        // https://dev.to/abdisalan_js/how-to-code-a-video-streaming-server-using-nodejs-2o0
        // As of 1/25/22, works in Chrome but not Safari
        app.get('/video/:id', function(req, res) {
            const range = req.headers.range;
            if (!range) {
                res.status(400).send('Requires Range header');
                return;
            }

            const videoPath = path.join(this.outputPath, req.params.id);

            if (!fs.existsSync(videoPath)) {
                res.status(404).send('No video at path: ' + videoPath);
                return;
            }

            const videoSize = fs.statSync(videoPath).size;
            // console.log('Video Size = ' + Math.round(videoSize / 1000)  + 'kb');

            // Parse Range (example: "bytes=32324-")
            const CHUNK_SIZE = 10 ** 6; // 1 MB
            const start = Number(range.replace(/\D/g, ''));
            const end = Math.min(start + CHUNK_SIZE, videoSize - 1);

            // Create Headers
            const contentLength = end - start + 1;
            const headers = {
                'Content-Range': `bytes ${start}-${end}/${videoSize}`,
                'Accept-Ranges': 'bytes',
                'Content-Length': contentLength,
                'Content-Type': 'video/mp4',
            };

            // HTTP Status 206 for partial content
            res.writeHead(206, headers);
            const videoStream = fs.createReadStream(videoPath, { start, end });
            videoStream.pipe(res);
        }.bind(this));
    }
    startRecording() {
        this.isRecording = true;

        // start color stream process
        this.processes[this.PROCESS.COLOR] = this.ffmpeg_image2mp4('color_stream', 8, 'mjpeg', 1920, 1080, 25, 0.25);
        if (this.processes[this.PROCESS.COLOR]) {
            this.processStatuses[this.PROCESS.COLOR] = this.STATUS.STARTED;
        }

        // start depth stream process
        this.processes[this.PROCESS.DEPTH] = this.ffmpeg_image2mp4('depth_stream', 8, 'png', 1920, 1080, 25, 0.25);
        if (this.processes[this.PROCESS.DEPTH]) {
            this.processStatuses[this.PROCESS.DEPTH] = this.STATUS.STARTED;
        }

        setTimeout(function() {
            this.stopRecording();
            setTimeout(function() {
                this.startRecording();
            }.bind(this), 100);
        }.bind(this), 30000);
    }
    stopRecording() {
        this.isRecording = false;

        let colorProcess = this.processes[this.PROCESS.COLOR];
        let depthProcess = this.processes[this.PROCESS.DEPTH];
        let colorStatus = this.processStatuses[this.PROCESS.COLOR];
        let depthStatus = this.processStatuses[this.PROCESS.DEPTH];

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
    onFrame(rgb, depth, _pose) {
        if (!this.anythingReceived) {
            this.startRecording(); // start recording the first time it receives a data packet
            this.anythingReceived = true;
        }
        if (!this.isRecording) {
            return;
        }

        let colorProcess = this.processes[this.PROCESS.COLOR];
        let depthProcess = this.processes[this.PROCESS.DEPTH];
        let colorStatus = this.processStatuses[this.PROCESS.COLOR];
        let depthStatus = this.processStatuses[this.PROCESS.DEPTH];

        if (typeof colorProcess !== 'undefined' && colorStatus === 'STARTED') {
            colorProcess.stdin.write(rgb);
        }

        if (typeof depthProcess !== 'undefined' && depthStatus === 'STARTED') {
            depthProcess.stdin.write(depth);
        }
    }
    ffmpeg_concat_mp4s(output_name, file_list_path) {
        // ffmpeg -f concat -safe 0 -i fileList.txt -c copy mergedVideo.mp4

        let filePath = path.join(this.outputPath, output_name + '_' + Date.now() + '.mp4');
        let args = [
            '-f', 'concat',
            '-safe', '0',
            '-i', file_list_path,
            '-c', 'copy',
            filePath
        ];

        cp.spawn('ffmpeg', args);

        return filePath;
    }
    ffmpeg_image2mp4(output_name, framerate = 8, input_vcodec = 'mjpeg', input_width = 1920, input_height = 1080, crf = 25, output_scale = 0.25) {
        let filePath = path.join(this.outputPath, output_name + '_' + Date.now() + '.mp4');

        let outputWidth = input_width * output_scale;
        let outputHeight = input_height * output_scale;

        let args = [
            '-r', framerate,
            '-f', 'image2pipe',
            '-vcodec', input_vcodec,
            '-s', input_width + 'x' + input_height,
            '-i', '-',
            '-vcodec', 'libx264',
            '-crf', crf,
            '-pix_fmt', 'yuv420p',
            '-vf', 'scale=' + outputWidth + ':' + outputHeight + ',setsar=1:1',
            filePath
        ];

        // let args = [
        //     '-r', '10',
        //     '-f', 'image2pipe'
        // ];
        // if (imageType === 'color') {
        //     args.push('-vcodec', 'mjpeg');
        // }
        // args.push(
        //     '-s', inputWidth + 'x' + inputHeight,
        //     // '-i', inputPath,
        //     '-i', '-',
        //     '-vcodec', 'libx264',
        //     '-crf', '25',
        //     '-pix_fmt', 'yuv420p',
        //     '-vf', 'scale=' + width + ':' + height + ',setsar=1:1',
        //     outputPath
        // );

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
}

module.exports = VideoServer;
