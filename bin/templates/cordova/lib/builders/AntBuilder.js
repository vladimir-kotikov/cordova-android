/*
       Licensed to the Apache Software Foundation (ASF) under one
       or more contributor license agreements.  See the NOTICE file
       distributed with this work for additional information
       regarding copyright ownership.  The ASF licenses this file
       to you under the Apache License, Version 2.0 (the
       "License"); you may not use this file except in compliance
       with the License.  You may obtain a copy of the License at

         http://www.apache.org/licenses/LICENSE-2.0

       Unless required by applicable law or agreed to in writing,
       software distributed under the License is distributed on an
       "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
       KIND, either express or implied.  See the License for the
       specific language governing permissions and limitations
       under the License.
*/

var Q = require('q');
var fs = require('fs');
var path = require('path');
var util = require('util');
var shell = require('shelljs');
var spawn = require('../spawn');
var check_reqs = require('../check_reqs');

var ROOT = path.resolve(__dirname, '../../..');
var SIGNING_PROPERTIES = '-signing.properties';
var MARKER = 'YOUR CHANGES WILL BE ERASED!';
var TEMPLATE =
    '# This file is automatically generated.\n' +
    '# Do not modify this file -- ' + MARKER + '\n';

var GenericBuilder = require('./GenericBuilder');

function AntBuilder (eventEmitter) {
    GenericBuilder.call(this, eventEmitter);
}

util.inherits(AntBuilder, GenericBuilder);

AntBuilder.prototype.getArgs = function(cmd, opts) {
    var args = [cmd, '-f', path.join(ROOT, 'build.xml')];
    // custom_rules.xml is required for incremental builds.
    if (hasCustomRules()) {
        args.push('-Dout.dir=ant-build', '-Dgen.absolute.dir=ant-gen');
    }
    if(opts.packageInfo) {
        args.push('-propertyfile=' + path.join(ROOT, opts.buildType + SIGNING_PROPERTIES));
    }
    return args;
};

AntBuilder.prototype.prepEnv = function(opts) {
    var self = this;
    return check_reqs.check_ant()
    .then(function() {
        // Copy in build.xml on each build so that:
        // A) we don't require the Android SDK at project creation time, and
        // B) we always use the SDK's latest version of it.
        var sdkDir = process.env['ANDROID_HOME'];
        var buildTemplate = fs.readFileSync(path.join(sdkDir, 'tools', 'lib', 'build.template'), 'utf8');
        function writeBuildXml(projectPath) {
            var newData = buildTemplate.replace('PROJECT_NAME', self.extractProjectNameFromManifest(ROOT));
            fs.writeFileSync(path.join(projectPath, 'build.xml'), newData);
            if (!fs.existsSync(path.join(projectPath, 'local.properties'))) {
                fs.writeFileSync(path.join(projectPath, 'local.properties'), TEMPLATE);
            }
        }
        writeBuildXml(ROOT);
        var propertiesObj = readProjectProperties();
        var subProjects = propertiesObj.libs;
        for (var i = 0; i < subProjects.length; ++i) {
            writeBuildXml(path.join(ROOT, subProjects[i]));
        }
        if (propertiesObj.systemLibs.length > 0) {
            throw new Error('Project contains at least one plugin that requires a system library. This is not supported with ANT. Please build using gradle.');
        }

        var propertiesFile = opts.buildType + SIGNING_PROPERTIES;
        var propertiesFilePath = path.join(ROOT, propertiesFile);
        if (opts.packageInfo) {
            fs.writeFileSync(propertiesFilePath, TEMPLATE + opts.packageInfo.toProperties());
        } else if(GenericBuilder.isAutoGenerated(propertiesFilePath)) {
            shell.rm('-f', propertiesFilePath);
        }
    });
};

/*
 * Builds the project with ant.
 * Returns a promise.
 */
AntBuilder.prototype.build = function(opts) {
    // Without our custom_rules.xml, we need to clean before building.
    var ret = Q();
    if (!hasCustomRules()) {
        // clean will call check_ant() for us.
        ret = this.clean(opts);
    }

    var self = this;
    var args = this.getArgs(opts.buildType == 'debug' ? 'debug' : 'release', opts);
    return check_reqs.check_ant()
    .then(function() {
        self.events.emit('verbose', 'Executing: ant ' + args.join(' '));
        return spawn('ant', args);
    });
};

AntBuilder.prototype.clean = function(opts) {
    var args = this.getArgs('clean', opts);
    var self = this;
    return check_reqs.check_ant()
    .then(function() {
        return spawn('ant', args);
    })
    .then(function () {
        shell.rm('-rf', path.join(self.root, 'out'));

        ['debug', 'release'].forEach(function(config) {
            var propertiesFilePath = path.join(self.root, config + SIGNING_PROPERTIES);
            if(GenericBuilder.isAutoGenerated(propertiesFilePath)){
                shell.rm('-f', propertiesFilePath);
            }
        });
    });
};

AntBuilder.prototype.findOutputApks = function(build_type) {
    var binDir = path.join(ROOT, hasCustomRules() ? 'ant-build' : 'bin');
    return GenericBuilder.findOutputApksHelper(binDir, build_type, null);
};


module.exports = AntBuilder;

function hasCustomRules() {
    return fs.existsSync(path.join(ROOT, 'custom_rules.xml'));
}

function readProjectProperties() {
    var data = fs.readFileSync(path.join(ROOT, 'project.properties'), 'utf8');
    return {
        libs: findAllUniq(data, /^\s*android\.library\.reference\.\d+=(.*)(?:\s|$)/mg),
        gradleIncludes: findAllUniq(data, /^\s*cordova\.gradle\.include\.\d+=(.*)(?:\s|$)/mg),
        systemLibs: findAllUniq(data, /^\s*cordova\.system\.library\.\d+=(.*)(?:\s|$)/mg)
    };
}

function findAllUniq(data, r) {
    var s = {};
    var m;
    while ((m = r.exec(data))) {
        s[m[1]] = 1;
    }
    return Object.keys(s);
}
