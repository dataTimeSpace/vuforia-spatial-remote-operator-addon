createNameSpace('realityEditor.videoPlayback');

(function (exports) {
    const MAX_SPEED = 256;
    class TimelineModel {
        constructor() {
            this.database = null;
            this.currentView = new realityEditor.videoPlayback.DataView();
            this.selectedDate = null;
            this.currentTimestamp = null;
            this.isPlaying = false;
            this.playbackSpeed = 1;
            this.timelineWindow = new realityEditor.videoPlayback.TimelineWindow();
            this.timelineWindow.onWithoutZoomUpdated(window => {
                this.handleWindowUpdated(window, true);
            });
            this.timelineWindow.onCurrentWindowUpdated(window => {
                this.handleWindowUpdated(window, false);
            });
            this.callbacks = {
                onDataLoaded: [],
                onDataViewUpdated: [],
                onWindowUpdated: [],
                onTimestampUpdated: [],
                onPlaybackToggled: [],
                onSpeedUpdated: []
            };
            this.playbackInterval = null;
            this.lastUpdate = null;
        }
        handleWindowUpdated(window, resetPlayhead) {
            // TODO: update data view
            console.log('new bounds', window.bounds);
            // update the timestamp based on its percent position and the new date
            let playheadTime = resetPlayhead ? window.bounds.current.min : this.currentTimestamp;
            this.setTimestamp(playheadTime, true);

            this.callbacks.onWindowUpdated.forEach(cb => {
                cb(window);
            });
        }
        setDatabase(database) {
            this.database = database;
            this.callbacks.onDataLoaded.forEach(cb => {
                cb('todo add data here');
            });
        }
        setTimestamp(newTimestamp, triggerCallbacks) {
            // if (this.currentTimestamp === newTimestamp) { return; } // don't update if no change
            this.currentTimestamp = newTimestamp;
            if (triggerCallbacks) {
                this.callbacks.onTimestampUpdated.forEach(cb => {
                    cb(this.currentTimestamp);
                });
            }
        }
        getPlayheadTimePercent(inWindow) {
            let min, max;
            if (inWindow) {
                min = this.timelineWindow.bounds.current.min;
                max = this.timelineWindow.bounds.current.max;
            } else {
                min = this.timelineWindow.bounds.withoutZoom.min;
                max = this.timelineWindow.bounds.withoutZoom.max;
            }
            return (this.currentTimestamp - min) / (max - min);
        }
        setTimestampFromPositionInWindow(percentInWindow) {
            let min = this.timelineWindow.bounds.current.min;
            let max = this.timelineWindow.bounds.current.max;
            let current = min + (max - min) * percentInWindow;
            this.setTimestamp(current, true);
        }
        adjustCurrentWindow(leftPercent, rightPercent) {
            this.timelineWindow.setCurrentFromPercent(leftPercent, rightPercent);
        }
        togglePlayback(toggled) {
            if (this.isPlaying === toggled) { return; }
            this.isPlaying = toggled;

            if (this.isPlaying) {
                if (!this.playbackInterval) {
                    this.lastUpdate = Date.now();
                    this.playbackInterval = setInterval(() => {
                        let now = Date.now();
                        let dt = now - this.lastUpdate;
                        this.lastUpdate = now;
                        this.playbackLoop(dt);
                    }, 16);
                }
            } else if (this.playbackInterval) {
                clearInterval(this.playbackInterval);
                this.playbackInterval = null;
            }

            // TODO: play videos, begin data processing, etc
            this.callbacks.onPlaybackToggled.forEach(cb => {
                cb(this.isPlaying);
            });
        }
        playbackLoop(dt) {
            // update the timestamp based on time passed and process any data segments
            let newTime = this.currentTimestamp + dt * this.playbackSpeed;
            if (newTime > this.timelineWindow.bounds.withoutZoom.max) {
                newTime = this.timelineWindow.bounds.withoutZoom.max;
                this.togglePlayback(false);
            }
            this.setTimestamp(newTime, true);
        }
        multiplySpeed(factor, allowLoop) {
            this.playbackSpeed *= factor;
            if (this.playbackSpeed > MAX_SPEED) {
                this.playbackSpeed = allowLoop ? 1 : MAX_SPEED;
            } else if (this.playbackSpeed < 1) {
                this.playbackSpeed = allowLoop ? MAX_SPEED : 1;
            }
            this.callbacks.onSpeedUpdated.forEach(cb => {
                cb(this.playbackSpeed);
            });
        }
        /*
        Callback Subscription Methods
        */
        onDataLoaded(callback) {
            this.callbacks.onDataLoaded.push(callback);
        }
        onDataViewUpdated(callback) {
            this.callbacks.onDataViewUpdated.push(callback);
        }
        onWindowUpdated(callback) {
            this.callbacks.onWindowUpdated.push(callback);
        }
        onTimestampUpdated(callback) {
            this.callbacks.onTimestampUpdated.push(callback);
        }
        onPlaybackToggled(callback) {
            this.callbacks.onPlaybackToggled.push(callback);
        }
        onSpeedUpdated(callback) {
            this.callbacks.onSpeedUpdated.push(callback);
        }
    }

    exports.TimelineModel = TimelineModel;
})(realityEditor.videoPlayback);
