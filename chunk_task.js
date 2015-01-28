importScripts('q.js');

var workerIndex;

onmessage = function (evt) {
	var data = evt.data;

	if(data.action === 'do') {
		var task = new ChunkTask();
		task.start(data.startIndex, data.endIndex, data.query, data.file);
	} else if(data.action === 'init') {
		workerIndex = data.workerIndex;
	}
};

var ChunkTask = function ChunkTask() {
	var capturingMultiLineLogMatcher = /\[([^\]]*)\]\s\[([^\]]*)\]\s\[([^\]]*)\]\s\[([^\]]*)\]\s([A-Z]+)\s+\|([^\|]*)\|((?:(?!\n\[20)[\S|\s])*)/;
	var capturingSingleLineLogMatcher = /\[([^\]]*)\]\s\[([^\]]*)\]\s\[([^\]]*)\]\s\[([^\]]*)\]\s([A-Z]+)\s+\|([^\|]*)\|\s(.*)/;

	function readBlob(opt_startByte, opt_stopByte, file) {
		var deferred = Q.defer();

		var start = parseInt(opt_startByte, 10) || 0;
		var stop = parseInt(opt_stopByte, 10) || start + 1000;

		//Restrict stop marker to EOF
		if(stop > file.size - 1) {
			console.warn('Stop marker outside file length. Setting to file length.');
			stop = file.size - 1;
		}

		var reader = new FileReader();

		reader.onloadend = function(e) {
			if (e.target.readyState == FileReader.DONE) { // DONE == 2
				deferred.resolve(e.target.result);
			}
		};

		var blob = file.slice(start, stop + 1);
		reader.readAsBinaryString(blob);

		return deferred.promise;
	}

	/**
	 * Get all lines inside of start and stop, and all complete all lines that are bordering before and after.
	 * @param startIndex
	 * @param stopIndex
	 * @returns promise
	 */
	function getLogLines(startIndex, stopIndex, file) {
		var allContent;

		var deferred = Q.defer();

		readBlob(startIndex, stopIndex, file)
			.then(function (data) {
				allContent = data;
			})
			.then(function() {
				return findContentBeforeLineBreak(startIndex - 1, false, file)
			})
			.then(function (data) {
				allContent = data + allContent;
			})
			.then(function() {
				return findContentBeforeLineBreak(stopIndex + 1, true, file)
			})
			.then(function (data) {
				allContent = allContent + data;
				deferred.resolve(allContent.split('\n[20'));
			})
			.fail(function (e) {
				deferred.reject(e);
			});

		return deferred.promise;

	}

	/**
	 * Finds all content from index to the nearest line break.
	 * @param index
	 * @param forward True to search forward in file, false to search backwards from index
	 * @returns promise
	 */
	function findContentBeforeLineBreak(index, forward, file) {
		var direction = forward ? 1 : -1;
		var index2 = index + 1024 * 512 * direction; //500KB should be plenty to find the end of a log entry...?
		var deferred = Q.defer();

		var start = Math.min(index, index2);
		var stopIndex = Math.max(index, index2);

		start = Math.max(start, 0);
		stopIndex = Math.min(stopIndex, file.size - 1);

		readBlob(start, stopIndex, file).then(function (data) {
			var pos, fragment;
			if (forward) {
				pos = data.indexOf('\n[20');
			} else {
				pos = data.lastIndexOf('\n[20');
			}

			if (pos == -1) {
				if(start === 0) {
					//Return everything before index because we are at the beginning of the file.
					deferred.resolve(data);
				} else if(stopIndex === file.size - 1) {
					//Return everything because we are at the end of the file
					deferred.resolve(data);
				} else {
					console.error('Could not find a line break');
					deferred.reject();
				}
			} else {
				if (forward) {
					fragment = data.substr(0, pos - 1);
				} else {
					fragment = data.substr(pos + 1);
				}

				deferred.resolve(fragment);
			}
		});

		return deferred.promise;
	}

	var LogLine = function LogLine(line) {

		/*
		 Example:
		 [2014-10-22 19:35:21,577] [SDI_VS_ANDROID  ] [                              ] [jILCT7CkUWHlr82yX9lI0g## ] INFO  |com.sdi.xbn.web.spring.SDAPILoggingFilter| ...restofmessage...

		 Matching groups:
		 (0: Whole string)
		 1.	`2014-10-22 19:35:21,577`
		 2.	`SDI_VS_ANDROID  `
		 3.	`                              `
		 4.	`jILCT7CkUWHlr82yX9lI0g## `
		 5.	`INFO`
		 6.	`com.sdi.xbn.web.spring.SDAPILoggingFilter`
		 7.	`ENTRY GET ...restofmessage...`
		 */
		this.line = line;
		var fields = line.match(capturingMultiLineLogMatcher);
		if(fields) {
			this.time = fields[1];
			this.appId = fields[2];
			this.logId1 = fields[3];
			this.logId2 = fields[4];
			this.level = fields[5];
			this.className = fields[6];
			this.message = fields[7];
		} else {
			this.error = true;
		}
	};

	var analyze = function analyze(lines, query) {
		var sizeOfMatchedData = 0;
		var resultCount = 0;
		var matchesDictionary = [];
		var keys = [];
		var bytesRead = 0;
        var linesSinceFlush = 0;
        
        var queryRegex = new RegExp(query);

		var appendResult = function(logLine) {
			matchesDictionary[logLine.logId2].push(logLine);
		};
        
        var flush = function flush() {
            postMessage({
                msg: 'resultCount',
                results: resultCount,
                bytesRead: bytesRead
            });
            
            bytesRead = 0;
            resultCount = 0;
            linesSinceFlush = 0;
        };

		lines.forEach(function(line) {

			line = '[20' + line; //Fix split
			bytesRead += line.length;

			var parsedLine = new LogLine(line);
			var hasEntry = (matchesDictionary[parsedLine.logId2]);

			if (hasEntry) {
				appendResult(parsedLine);
			} else if(line.match(queryRegex)) {
				sizeOfMatchedData += line.length;
				resultCount++;
                
                if(linesSinceFlush > 100000) {
                    flush();    
                }
                

				if(parsedLine.logId2) {
					if(!hasEntry) {
						keys.push(parsedLine.logId2);
						matchesDictionary[parsedLine.logId2] = [];
					}
					appendResult(parsedLine);
				}
			}
		});
        
        flush();

		return {
			matches: matchesDictionary,
			keys: keys,
			bytesRead: bytesRead,
			sizeOfMatchedData: sizeOfMatchedData,
			workerIndex: workerIndex
		};
	};

	this.start = function start(startIndex, endIndex, query, file) {

		getLogLines(startIndex, endIndex, file)
			.then(function(fileContents) {
				postMessage("parsePhase");
				return analyze(fileContents, query);
			})
			.then(function(results) {
				postMessage({
                    msg: 'done',
                    results: results,
                    workerIndex: workerIndex
                });
			})
			.fail(function(e) {
				console.error(e);
			});
	}
};