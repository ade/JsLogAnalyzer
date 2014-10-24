var boundary = 1000 * 1000 * 5; //MB
var chunkSize = 1000 * 1000; //1 MB
var searchButton = document.querySelector('#searchbutton');
var cursorPositionLabel = document.querySelector('#cursor_position');
var resultCountLabel = document.querySelector('#result_count');
var readFrom = document.querySelector("#read-from");
var readTo = document.querySelector("#read-to");
var filePicker = document.querySelector("#files");
var progressBar = document.querySelector("#progress-bar");
var fileSize;
var capturingMultiLineLogMatcher = /\[([^\]]*)\]\s\[([^\]]*)\]\s\[([^\]]*)\]\s\[([^\]]*)\]\s([A-Z]+)\s+\|([^\|]*)\|((?:(?!\n\[20)[\S|\s])*)/;
var capturingSingleLineLogMatcher = /\[([^\]]*)\]\s\[([^\]]*)\]\s\[([^\]]*)\]\s\[([^\]]*)\]\s([A-Z]+)\s+\|([^\|]*)\|\s(.*)/;
var fileReadEndTime;

var setSliderLabels = function setSliderValues() {
	document.querySelector('#read-from-label').textContent = bytesToSize(readFrom.value);
	document.querySelector('#read-to-label').textContent = bytesToSize(readTo.value);
};

readFrom.addEventListener('change', setSliderLabels);
readTo.addEventListener('change', setSliderLabels);

filePicker.addEventListener('change', function() {
	fileSize = getFileSize();
	readFrom.disabled = false;
	readTo.disabled = false;
	readFrom.max = fileSize-2;
	readTo.max = fileSize-1;

	var defaultValue = Math.min(fileSize, 1024*1024*300);

	readFrom.value = fileSize - 1024 * 1024 * 200;
	readTo.value = fileSize;

	setSliderLabels();
});

function getFileSize() {
	var files = document.getElementById('files').files;
	if (files.length) {
		return files[0].size;
	} else {
		throw new Error('No file');
	}
}

function readBlob(opt_startByte, opt_stopByte) {
	var deferred = Q.defer();

	var files = document.getElementById('files').files;
	if (!files.length) {
		alert('Please select a file!');
		return;
	}

	var file = files[0];
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
function getLogLines(startIndex, stopIndex) {
	var allContent;

	var deferred = Q.defer();

	readBlob(startIndex, stopIndex)
		.then(function (data) {
			allContent = data;
		})
		.then(function() {
			return findContentBeforeLineBreak(startIndex - 1, false)
		})
		.then(function (data) {
			allContent = data + allContent;
		})
		.then(function() {
			return findContentBeforeLineBreak(stopIndex + 1, true)
		})
		.then(function (data) {
			allContent = allContent + data;
			fileReadEndTime = new Date();
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
function findContentBeforeLineBreak(index, forward) {
	var direction = forward ? 1 : -1;
	var index2 = index + 1024 * 512 * direction; //500KB should be plenty to find the end of a log entry...?
	var deferred = Q.defer();

	var start = Math.min(index, index2);
	var stopIndex = Math.max(index, index2);

	start = Math.max(start, 0);
	stopIndex = Math.min(stopIndex, fileSize - 1);

	readBlob(start, stopIndex).then(function (data) {
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
			} else if(stopIndex === fileSize - 1) {
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

var Search = function(startIndex, limitIndex, forward) {
	var position = startIndex;
	var deferred = Q.defer();
	var SEARCH_FRAME_SIZE = 32 * 1024 * 1024; //50MB
	var query = document.querySelector('#pattern').value;
	var direction = forward ? 1 : -1;
	var searchStartedAt = new Date();
	var sizeOfMatchedData = 0;
	var resultCount = 0;
	var stringResults = '';
	var matchesDictionary = [];
	var keys = [];
	var lineCount = 0;
	var bytesProcessed = 0;
	var timeSpentParsing = 0;

	var readNext = function() {
		if(forward) {
			if(position > limitIndex) {
				finish();
			} else {
				getLogLines(position, position + (SEARCH_FRAME_SIZE * direction))
					.then(analyze)
					.then(function() {
						position += SEARCH_FRAME_SIZE * direction;
						bytesProcessed += SEARCH_FRAME_SIZE;
						progressBar.value = bytesProcessed;
						cursorPositionLabel.textContent = bytesToSize(position) + ", parsed " + lineCount + " entries";
						resultCountLabel.textContent = resultCount + " (" + bytesToSize(sizeOfMatchedData) + ")";
						timeSpentParsing += new Date() - fileReadEndTime;
						readNext();
					})
					.fail(function(e) {
						console.error(e);
					});
			}
		}
	};

	var finish = function() {
		deferred.resolve({
			results: stringResults,
			timeTakenMs: new Date() - searchStartedAt,
			entriesSearched: lineCount,
			bytesSearched: Math.abs(startIndex - limitIndex),
			matchesDictionary: matchesDictionary,
			timeSpentParsing: timeSpentParsing,
			keys: keys
		});
	};

	var appendResult = function(logLine) {
		matchesDictionary[logLine.logId2].push(logLine);
	};

	var analyze = function analyze(lines) {
		lineCount += lines.length;

		lines.forEach(function(line) {
			line = '[20' + line; //Fix split
			var parsedLine = new LogLine(line);
			var hasEntry = (matchesDictionary[parsedLine.logId2]);

			if (hasEntry) {
				appendResult(parsedLine);
			} else if(line.indexOf(query) > -1) {
				sizeOfMatchedData += line.length;
				resultCount++;

				if(parsedLine.logId2) {
					if(!hasEntry) {
						keys.push(parsedLine.logId2);
						matchesDictionary[parsedLine.logId2] = [];
					}
					appendResult(parsedLine);
				}
				return true;
			}
		});
	};

	this.search = function search() {
		readNext();
		return deferred.promise;
	}
};

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

var bytesToSize = function bytesToSize(bytes) {
	var sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
	if (bytes == 0) return '0 Byte';
	var i = parseInt(Math.floor(Math.log(bytes) / Math.log(1024)));
	return Math.round((bytes / Math.pow(1024, i) * 100)) / 100 + ' ' + sizes[i];
};

var presentResults = function presentResults(results) {
	var outputbox = document.querySelector("#fancy_output");
	var matches = results.matchesDictionary;
	var fragment = document.createDocumentFragment();
	var source   = document.querySelector("#line-template").innerHTML;
	var template = Handlebars.compile(source);

	results.keys.forEach(function(key) {
		var result = matches[key];
		var container = document.createElement("div");
		container.style.background = randomColorString();
		fragment.appendChild(container);

		result.forEach(function(lineObject) {
			container.innerHTML += template(lineObject);
		});
	});
	outputbox.innerHTML = '';
	outputbox.appendChild(fragment);
};

function randomColorString () {
	function randomColor () {
		return ( Math.round( Math.random() * 127 ) + 127 ).toString( 16 );
	}
	var r = randomColor(),
		g = randomColor(),
		b = randomColor();
	return '#' + r + g + b;
}

searchButton.addEventListener('click', function() {
	searchButton.textContent = 'Searching...';
	searchButton.disabled = true;
	var start = parseInt(readFrom.value, 10);
	var end = parseInt(readTo.value, 10);
	if(start > end) {
		alert('invalid start/stop values');
		return;
	}
	end = Math.min(fileSize, end);

	progressBar.max = end - start;

	var searcher = new Search(start, end, true);

	searcher.search()
		.then(function(e) {
			var entrySpeed = Math.round((e.entriesSearched / (e.timeTakenMs / 1000)) / 1000);

			var byteSpeed = bytesToSize(e.bytesSearched / (e.timeTakenMs / 1000));
			cursorPositionLabel.textContent = e.entriesSearched + " entries searched in " + Math.round(e.timeTakenMs/1000) + " sec (" + entrySpeed + "k entries/sec, " + byteSpeed + "/sec), time spent parsing: " + e.timeSpentParsing;

			searchButton.textContent = 'Search';
			searchButton.disabled = false;

			presentResults(e);
		})
		.fail(function() {
			cursorPositionLabel.textContent = "Failed";
			searchButton.textContent = 'Search';
			searchButton.disabled = false;
		});
}, false);
