createNameSpace('realityEditor.gui');

import Splatting from '../../src/splatting/Splatting.js';

(function(exports) {
    let menuBar = null;

    const MENU = Object.freeze({
        View: 'View',
        Camera: 'Camera',
        Follow: 'Follow',
        History: 'History',
        Help: 'Help',
        Develop: 'Develop'
    });
    exports.MENU = MENU;

    const ITEM = Object.freeze({
        PointClouds: '3D Videos',
        SpaghettiMap: 'Spaghetti Map',
        ModelVisibility: 'Model Visibility',
        ModelTexture: 'Model Texture',
        SurfaceAnchors: 'Surface Anchors',
        VideoPlayback: 'Video Timeline',
        Voxelizer: 'Model Voxelizer',
        Follow1stPerson: 'Follow 1st-Person',
        Follow3rdPerson: 'Follow 3rd-Person',
        StopFollowing: 'Stop Following',
        TakeSpatialSnapshot: 'Take Spatial Snapshot',
        OrbitCamera: 'Orbit Camera',
        ResetCameraPosition: 'Reset Camera Position',
        GettingStarted: 'Getting Started',
        ShowDeveloperMenu: 'Show Developer Menu',
        DebugAvatarConnections: 'Debug Avatar Connections',
        DeleteAllTools: 'Delete All Tools',
        DownloadScan: 'Download Scan',
        DownloadZipBackup: 'Download World Object',
        ViewCones: 'Show View Cones',
        AdvanceCameraShader: 'Next Camera Lens',
        ToggleMotionStudySettings: 'Toggle Analytics Settings',
        DarkMode: 'Dark Mode',
        CutoutViewFrustums: 'Cut Out 3D Videos',
        ShowFPS: 'Show FPS',
        ActivateProfiler: 'Activate Profiler',
        ToggleFlyMode: 'Fly Mode',
        FocusCamera: 'Focus Camera',
        ReloadPage: 'Reload Page',
        GSSettingsPanel: 'GS Settings Panel',
        GSToggleRaycast: 'GS Toggle Raycast',
        CloseAllOtherTools: 'No Tools Open',
        ToggleFullscreen: 'Enter Fullscreen',
    });
    exports.ITEM = ITEM;

    // sets up the initial contents of the menuBar
    // other modules can add more to it by calling getMenuBar().addItemToMenu(menuName, menuItem)
    const setupMenuBar = () => {
        if (menuBar) { return; }

        const MenuBar = realityEditor.gui.MenuBar;
        const Menu = realityEditor.gui.Menu;
        const MenuItem = realityEditor.gui.MenuItem;

        menuBar = new MenuBar();
        // menuBar.addMenu(new Menu('File'));
        // menuBar.addMenu(new Menu('Edit'));
        menuBar.addMenu(new Menu(MENU.View));
        menuBar.addMenu(new Menu(MENU.Camera));
        let followMenu = new Menu(MENU.Follow); // keep a reference, so we can show/hide it on demand
        exports.followMenu = followMenu;
        menuBar.addMenu(followMenu);
        menuBar.disableMenu(followMenu);
        menuBar.addMenu(new Menu(MENU.History));
        let developMenu = new Menu(MENU.Develop); // keep a reference, so we can show/hide it on demand
        menuBar.addMenu(developMenu);
        menuBar.hideMenu(developMenu);
        menuBar.addMenu(new Menu(MENU.Help));

        const toggleFullscreen = new MenuItem(ITEM.ToggleFullscreen, {}, () => {
            if (document.fullscreenElement) {
                document.exitFullscreen();
            } else {
                document.body.requestFullscreen();
            }
        });
        document.body.addEventListener('fullscreenchange', () => {
            if (document.fullscreenElement) {
                toggleFullscreen.setText('Exit Fullscreen');
            } else {
                toggleFullscreen.setText('Enter Fullscreen');
            }
        });
        menuBar.addItemToMenu(MENU.View, toggleFullscreen);

        const closeAllOtherTools = new MenuItem(ITEM.CloseAllOtherTools, { disabled: true }, () => {
            const isAnythingCurrentlyFocused = realityEditor.envelopeManager.getFocusedEnvelopes().length > 0;
            const numOthersOpen = realityEditor.envelopeManager.getOpenEnvelopes().filter(envelope => {
                return !envelope.hasFocus;
            }).length;
            const canCloseActiveTool = isAnythingCurrentlyFocused && numOthersOpen === 0;

            realityEditor.envelopeManager.getOpenEnvelopes().forEach(envelope => {
                if (!envelope.hasFocus || canCloseActiveTool) {
                    realityEditor.envelopeManager.closeEnvelope(envelope.frame);
                }
            });
        });
        menuBar.addItemToMenu(MENU.View, closeAllOtherTools);

        // Update the Close All Other Tools button text and disabled state based on current tool state
        const updateCloseOtherTools = () => {
            const isAnythingCurrentlyFocused = realityEditor.envelopeManager.getFocusedEnvelopes().length > 0;
            const othersOpen = realityEditor.envelopeManager.getOpenEnvelopes().filter(envelope => {
                return !envelope.hasFocus;
            });
            if (othersOpen.length > 0) {
                if (isAnythingCurrentlyFocused) {
                    // If something is focused, the button lets you close other distractions
                    closeAllOtherTools.setText(`Close All Other Tools (${othersOpen.length})`);
                } else {
                    // If nothing is focused, the button lets you close everything
                    closeAllOtherTools.setText(`Close All Tools (${othersOpen.length})`);
                }
                closeAllOtherTools.enable();
            } else {
                if (isAnythingCurrentlyFocused) {
                    // If only one tool open, and it's actively focused, this button can close it
                    closeAllOtherTools.setText('Close Active Tool');
                    closeAllOtherTools.enable();
                } else {
                    // If no tools open...
                    closeAllOtherTools.setText('No Tools Open');
                    closeAllOtherTools.disable();
                }
            }
        }
        realityEditor.envelopeManager.onOpen(updateCloseOtherTools);
        realityEditor.envelopeManager.onClose(updateCloseOtherTools);
        realityEditor.envelopeManager.onFocus(updateCloseOtherTools);
        realityEditor.envelopeManager.onBlur(updateCloseOtherTools);

        const togglePointClouds = new MenuItem(ITEM.PointClouds, { shortcutKey: 'M', toggle: true, defaultVal: true, disabled: true }, (value) => {
            console.log('toggle point clouds', value);
        });
        menuBar.addItemToMenu(MENU.View, togglePointClouds);

        const toggleSpaghetti = new MenuItem(ITEM.SpaghettiMap, { shortcutKey: 'N', toggle: true, defaultVal: false, disabled: true }, null);
        menuBar.addItemToMenu(MENU.View, toggleSpaghetti);

        const toggleModelVisibility = new MenuItem(ITEM.ModelVisibility, { shortcutKey: 'T', toggle: true, defaultVal: true }, null); // other module can attach a callback later
        menuBar.addItemToMenu(MENU.View, toggleModelVisibility);

        const toggleModelTexture = new MenuItem(ITEM.ModelTexture, { shortcutKey: 'Y', toggle: true, defaultVal: true }, null);
        menuBar.addItemToMenu(MENU.View, toggleModelTexture);

        const toggleViewCones = new MenuItem(ITEM.ViewCones, { shortcutKey: 'K', toggle: true, defaultVal: false }, null);
        menuBar.addItemToMenu(MENU.View, toggleViewCones);

        const toggleCutoutViewFrustums = new MenuItem(ITEM.CutoutViewFrustums, { toggle: true, defaultVal: false }, null);
        menuBar.addItemToMenu(MENU.View, toggleCutoutViewFrustums);

        // Note: these features still exist in the codebase, but have been removed from the menu for now
        // const toggleSurfaceAnchors = new MenuItem(ITEM.SurfaceAnchors, { shortcutKey: 'SEMICOLON', toggle: true, defaultVal: false }, null); // other module can attach a callback later
        // menuBar.addItemToMenu(MENU.View, toggleSurfaceAnchors);
        // const toggleVideoPlayback = new MenuItem(ITEM.VideoPlayback, { shortcutKey: 'OPEN_BRACKET', toggle: true, defaultVal: false }, null); // other module can attach a callback later
        // menuBar.addItemToMenu(MENU.View, toggleVideoPlayback);

        const toggleDarkMode = new MenuItem(ITEM.DarkMode, { toggle: true, defaultVal: true }, null);
        menuBar.addItemToMenu(MENU.View, toggleDarkMode);

        const toggleFlyMode = new MenuItem(ITEM.ToggleFlyMode, { toggle: true, shortcutKey: 'F', defaultVal: false }, null);
        menuBar.addItemToMenu(MENU.Camera, toggleFlyMode);

        const focusCamera = new MenuItem(ITEM.FocusCamera, { shortcutKey: 'G' }, null);
        menuBar.addItemToMenu(MENU.Camera, focusCamera);

        const rzvAdvanceCameraShader = new MenuItem(ITEM.AdvanceCameraShader, { disabled: true }, null);
        menuBar.addItemToMenu(MENU.Camera, rzvAdvanceCameraShader);

        const toggleMotionStudySettings = new MenuItem(ITEM.ToggleMotionStudySettings, { toggle: true, defaultVal: false }, null);
        menuBar.addItemToMenu(MENU.History, toggleMotionStudySettings);

        const takeSpatialSnapshot = new MenuItem(ITEM.TakeSpatialSnapshot, { shortcutKey: 'P', disabled: true }, null);
        menuBar.addItemToMenu(MENU.History, takeSpatialSnapshot);

        const toggleVoxelizer = new MenuItem(ITEM.Voxelizer, { shortcutKey: '', toggle: true, defaultVal: false }, null); // other module can attach a callback later
        menuBar.addItemToMenu(MENU.History, toggleVoxelizer);

        const stopFollowing = new MenuItem(ITEM.StopFollowing, { shortcutKey: '_0', toggle: false, disabled: true }, null);
        exports.stopFollowingItem = stopFollowing;
        menuBar.addItemToMenu(MENU.Follow, stopFollowing);

        const orbitCamera = new MenuItem(ITEM.OrbitCamera, { shortcutKey: 'O', toggle: true, defaultVal: false }, null);
        menuBar.addItemToMenu(MENU.Camera, orbitCamera);

        const resetCamera = new MenuItem(ITEM.ResetCameraPosition, { shortcutKey: 'ESCAPE' }, null);
        menuBar.addItemToMenu(MENU.Camera, resetCamera);

        // TODO: build a better Getting Started / Help experience
        // const gettingStarted = new MenuItem(ITEM.GettingStarted, null, () => {
        //     window.open('https://spatialtoolbox.vuforia.com/', '_blank');
        // });
        // menuBar.addItemToMenu(MENU.Help, gettingStarted);

        // useful in Teams or other iframe-embedded versions of the app, where you are otherwise unable to refresh the page
        const reloadPage = new MenuItem(ITEM.ReloadPage, null, () => {
            // reload and bypass the cache (https://stackoverflow.com/questions/2099201/javascript-hard-refresh-of-current-page)
            window.location.reload(true);
        });
        menuBar.addItemToMenu(MENU.Help, reloadPage);

        const activateProfiler = new MenuItem(ITEM.ActivateProfiler, { toggle: true, defaultVal: false }, (checked) => {
            if (checked) {
                if (realityEditor.device.profiling) realityEditor.device.profiling.show();
            } else {
                if (realityEditor.device.profiling) realityEditor.device.profiling.hide();
            }
        });
        menuBar.addItemToMenu(MENU.Develop, activateProfiler);

        const debugAvatars = new MenuItem(ITEM.DebugAvatarConnections, { toggle: true }, (checked) => {
            realityEditor.avatar.toggleDebugMode(checked);
        });
        menuBar.addItemToMenu(MENU.Develop, debugAvatars);

        const showFPS = new MenuItem(ITEM.ShowFPS, { toggle: true }, (checked) => {
            if (checked) {
                realityEditor.device.desktopStats.show();
            } else {
                realityEditor.device.desktopStats.hide();
            }
        });
        menuBar.addItemToMenu(MENU.Develop, showFPS);

        const deleteAllTools = new MenuItem(ITEM.DeleteAllTools, { toggle: false }, async () => {
            const framesToDelete = [];

            // collect frames to delete before we loop through them to perform the deletion
            realityEditor.forEachFrameInAllObjects((objectKey, frameKey) => {
                let object = realityEditor.getObject(objectKey);
                if (!object) return;
                // only delete for regular objects, world objects, and anchor objects - don't delete avatar or human pose frames
                if (object.type !== 'object' && object.type !== 'world' && object.type !== 'anchor') return;

                let frameToDelete = realityEditor.getFrame(objectKey, frameKey);
                if (frameToDelete) framesToDelete.push(frameToDelete);
            });

            // go through each one and confirm individually with modals
            for (const frame of framesToDelete) {
                await realityEditor.device.tryToDeleteSelectedVehicle(frame);
                // tryToDeleteSelectedVehicle will await any modals' decisions before the next one
            }
        });
        menuBar.addItemToMenu(MENU.Develop, deleteAllTools);

        const downloadScan = new MenuItem(ITEM.DownloadScan, { disabled: true });
        menuBar.addItemToMenu(MENU.Develop, downloadScan);

        const downloadZipBackup = new MenuItem(ITEM.DownloadZipBackup, { disabled: false }, () => {
            let worldObject = realityEditor.worldObjects.getBestWorldObject();
            if (worldObject) {
                const objPath = realityEditor.network.getURL(worldObject.ip, realityEditor.network.getPort(worldObject), '/object/' + worldObject.name + '/zipBackup/');
                window.open(objPath, '_blank');
            }
        });
        menuBar.addItemToMenu(MENU.Develop, downloadZipBackup);

        const showDeveloper = new MenuItem(ITEM.ShowDeveloperMenu, { toggle: true }, (checked) => {
            if (checked) {
                menuBar.unhideMenu(developMenu);
            } else {
                menuBar.hideMenu(developMenu);
            }
        });
        menuBar.addItemToMenu(MENU.Help, showDeveloper);

        const gsSettingsPanel = new MenuItem(ITEM.GSSettingsPanel, { toggle: true, defaultVal: false }, (checked) => {
            if (checked) {
                Splatting.showGSSettingsPanel();
            } else {
                Splatting.hideGSSettingsPanel();
            }
        });
        menuBar.addItemToMenu(MENU.Develop, gsSettingsPanel);

        const gsCanToggleRaycast = new MenuItem(ITEM.GSToggleRaycast, { shortcutKey: 'FORWARD_SLASH', toggle: true, defaultVal: true }, (checked) => {
            realityEditor.spatialCursor.gsCanToggleRaycast(checked);
        });
        menuBar.addItemToMenu(MENU.Develop, gsCanToggleRaycast);

        document.body.appendChild(menuBar.domElement);

        // Offset certain UI elements that align to the top of the screen, such as the envelope X button
        realityEditor.device.environment.variables.screenTopOffset = menuBar.domElement.getBoundingClientRect().height;
    };

    const getMenuBar = () => { // use this to access the shared MenuBar instance
        if (!menuBar) {
            try {
                setupMenuBar();
            } catch (e) {
                console.warn(e);
            }
        }
        return menuBar;
    };

    exports.setupMenuBar = setupMenuBar;
    exports.getMenuBar = getMenuBar;

})(realityEditor.gui);
