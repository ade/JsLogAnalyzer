var searchButton = document.querySelector('#searchbutton');
var cursorPositionLabel = document.querySelector('#cursor_position');
var resultCountLabel = document.querySelector('#result_count');
var readFrom = document.querySelector("#read-from");
var readTo = document.querySelector("#read-to");
var filePicker = document.querySelector("#files");
var progressBar = document.querySelector("#progress-bar");
var renderResultsCheckbox = document.querySelector("#render-results");
var outputbox = document.querySelector("#fancy_output");
var plainTextBox = document.querySelector("#plaintext");
var plainTextButton = document.querySelector("#plainTextToRegExp");
var regExpInput = document.querySelector('#pattern');
var jsEditorContainer = document.querySelector("#ace-editor-container");
var optionUseScript = document.querySelector("#option-use-script");
var autoSaveTimer = false;
var jsEditorErrorFlag = document.querySelector("#ace-editor-error-flag");

var RESULT_CACHE_LIMIT = 10000; //Soft limit. Hard limit seems to be around 20 000 before chrome crashes
var RESULT_RENDER_LIMIT = 50;

var fileSize;
var fileReadEndTime;

var jsEditor;

var workerCount = 4;
var workers = [];
for(var i = 0; i < workerCount; i++) {
	var worker = {
		worker: new Worker("chunk_task.js"),
		busy: false
	};
	workers.push(worker);
	worker.worker.postMessage({
		action: 'init',
		workerIndex: i
	});
}

var setSliderLabels = function setSliderValues() {
	document.querySelector('#read-from-label').textContent = bytesToSize(readFrom.value);
	document.querySelector('#read-to-label').textContent = bytesToSize(readTo.value);
};

readFrom.addEventListener('change', setSliderLabels);
readTo.addEventListener('change', setSliderLabels);

optionUseScript.addEventListener('change', onToggleUseScript);

filePicker.addEventListener('change', function() {
	fileSize = getFileSize();
	readFrom.disabled = false;
	readTo.disabled = false;
	readFrom.max = fileSize-2;
	readTo.max = fileSize-1;

	var defaultValue = Math.min(fileSize, 1024*1024*300);

	readFrom.value = 0;
	readTo.value = defaultValue;

	setSliderLabels();
});

var jsEditor = ace.edit("ace-editor");
jsEditor.setTheme("ace/theme/clouds");
jsEditor.getSession().setMode("ace/mode/javascript");

jsEditor.getSession().on('change', function() {
	clearTimeout(autoSaveTimer);
	autoSaveTimer = setTimeout(saveScript, 2000);
});

var savedScript = localStorage.getItem("savedParsingScript");
if(savedScript !== null) {
	jsEditor.setValue(savedScript);
	jsEditor.selection.selectFileStart();
}

function saveScript() {
	localStorage.setItem("savedParsingScript", jsEditor.getValue());
	console.log("Saved");
}

function onToggleUseScript(e) {
	if(optionUseScript.checked) {
		jsEditorContainer.classList.remove('hide');
	} else {
		jsEditorContainer.classList.add('hide');
	}
}

function getFileSize() {
	var files = document.getElementById('files').files;
	if (files.length) {
		return files[0].size;
	} else {
		throw new Error('No file');
	}
}

var Search = function(startIndex, limitIndex, forward) {
	var position = startIndex;
	var deferred = Q.defer();
	var SEARCH_FRAME_SIZE = 64 * 1024 * 1024;
    var query = regExpInput.value;
	var direction = forward ? 1 : -1;
	var searchStartedAt = new Date();
	var sizeOfMatchedData = 0;
	var resultCount = 0;
	var matches = [];
	var keys = [];
	var bytesProcessed = 0;
	var timeSpentParsing = 0;
    var parseScript;
	var errorInParseScript = false;
	var linesTotalAnalyzed = 0;

	if(optionUseScript.checked) {
		try {
			parseScript = eval(jsEditor.getValue());
			jsEditorErrorFlag.classList.add("hide");
		} catch (e) {
			parseScript = null;
			console.log(e);
			jsEditorErrorFlag.classList.remove("hide");
		}
	}

	var onWorkerEvent = function onWorkerEvent(event) {
        if (event.data === 'parsePhase') {
            if (position < limitIndex && getAvailableWorker() !== null) {
                delegateWork();
            }
            return;
        }

        if (event.data && event.data.msg) {
            switch (event.data.msg) {
                case 'resultCount':
                    resultCount += event.data.results;
                    bytesProcessed += event.data.bytesRead;
                    break;
                case 'done':
                    onWorkerDone(event);
                    break;
                default:
                    debugger;
            }
        }
    };
    
    var onWorkerDone = function onWorkerDone(event) {
		var msg = event.data.results;
		var index = event.data.workerIndex;
		linesTotalAnalyzed += msg.linesTotalAnalyzed;
		timeSpentParsing += msg.timeSpentParsing;

		workers[index].busy = false;

		msg.keys.forEach(function(key) {

			/*
            msg.matches[key].forEach(function(match) {
                parseScript.readLine(match);
            });
            */
			if(optionUseScript.checked && !errorInParseScript) {
				try {
					parseScript.readMatch(msg.matches[key]);
				}
				catch (e) {
					errorInParseScript = e;
					console.log(e);
					jsEditorErrorFlag.classList.remove("hide");
				}
			}

            
            if(resultCount < RESULT_CACHE_LIMIT) {
                if (matches[key]) {
                    matches[key].push(msg.matches[key]);
                } else {
                    matches[key] = msg.matches[key];
                }
                keys.push(key);
            }
		});

		var workerString = "";
		var workersWorking = false;
		workers.forEach(function(worker) {
			if(worker.busy) {
				workerString += "A,";
				workersWorking = true;
			} else {
				workerString += "-,";
			}
		});

		progressBar.value = bytesProcessed;
		cursorPositionLabel.textContent = 'Searched ' + bytesToSize(position) + ", parsed " + bigNumberFormat(linesTotalAnalyzed) + " entries [" + workerString + "]";
		resultCountLabel.textContent = resultCount + " (" + bytesToSize(sizeOfMatchedData) + ")";


        if(position <= limitIndex) {
            delegateWork();
        }
        
		if(!workersWorking && position > limitIndex) {
			finish();  
        }

	};

	var getAvailableWorker = function getAvailableWorker() {
		var ret = null;
		workers.forEach(function(worker) {
			if(!worker.busy) {
				ret = worker;
			}
		});
		return ret;
	};

	var readNext = function(worker) {
        if(worker === null) debugger;
		worker.busy = true;
		worker.worker.onmessage = onWorkerEvent;
		worker.worker.postMessage({
			action: 'do',
			startIndex: position,
			endIndex: position + (SEARCH_FRAME_SIZE * direction),
			query: query,
			file: filePicker.files[0]
		});
		position += SEARCH_FRAME_SIZE * direction;
		//bytesProcessed += SEARCH_FRAME_SIZE;
	};

	var delegateWork = function delegateWork() {
		var worker = getAvailableWorker();
		readNext(worker);
	};

	var finish = function() {
		var scriptOutput;
		if(optionUseScript.checked && !errorInParseScript) {
			try {
				scriptOutput = "(error occured)"
				scriptOutput = parseScript.getOutput();
			} catch (e) {
				console.log(e);
			}
		} else if(errorInParseScript) {
			scriptOutput = "(error occured)";
		} else {
			scriptOutput = "(inactive)"
		}

		deferred.resolve({
			timeTakenMs: new Date() - searchStartedAt,
			entriesSearched: linesTotalAnalyzed,
			bytesSearched: Math.abs(startIndex - limitIndex),
			matchesDictionary: matches,
			timeSpentParsing: timeSpentParsing,
			keys: keys,
			scriptResult: scriptOutput
		});
	};

	this.search = function search() {


		delegateWork();

		return deferred.promise;
	}
};

var bytesToSize = function bytesToSize(bytes) {
	var sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
	if (bytes == 0) return '0 Byte';
	var i = parseInt(Math.floor(Math.log(bytes) / Math.log(1024)));
	return Math.round((bytes / Math.pow(1024, i) * 100)) / 100 + ' ' + sizes[i];
};

function bigNumberFormat(num) {
	if (num >= 1000000000) {
		return (num / 1000000000).toFixed(1).replace(/\.0$/, '') + ' billion';
	}
	if (num >= 1000000) {
		return (num / 1000000).toFixed(1).replace(/\.0$/, '') + ' million';
	}
	if (num >= 1000) {
		return (num / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
	}
	return num;
}

var presentResults = function presentResults(results) {
	var matches = results.matchesDictionary;
	var fragment = document.createDocumentFragment();
	var source   = document.querySelector("#line-template").innerHTML;
	var template = Handlebars.compile(source);
    var drawCount = 0;
    
	results.keys.forEach(function(key) {
        if(drawCount < RESULT_RENDER_LIMIT) {
            var result = matches[key];
            var container = document.createElement("div");
            container.style.background = randomColorString();

            result.forEach(function (lineObject) {
                container.innerHTML += template(lineObject);
            });

			fragment.appendChild(container);
        }
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

plainTextButton.addEventListener('click', function() {
    var escaped = escapeRegExp(plainTextBox.value);
    regExpInput.value = escaped;
});

searchButton.addEventListener('click', function() {
    try {
        var queryRegex = new RegExp(regExpInput.value);
    } catch (e) {
        alert("invalid regexp!");
        return;
    }
    
    
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
    
    outputbox.innerHTML = '';

	var searcher = new Search(start, end, true);

	searcher.search()
		.then(function(e) {
			var entrySpeed = Math.round((e.entriesSearched / (e.timeTakenMs / 1000)) / 1000);

			var byteSpeed = bytesToSize(e.bytesSearched / (e.timeTakenMs / 1000));
			cursorPositionLabel.textContent = bigNumberFormat(e.entriesSearched) + " entries searched in " + Math.round(e.timeTakenMs/1000) + " sec (" + entrySpeed + "k entries/sec, " + byteSpeed + "/sec), time spent parsing: " + e.timeSpentParsing;

			searchButton.textContent = 'Search';
			searchButton.disabled = false;

            if(renderResultsCheckbox.checked) {
                presentResults(e);
            }

			document.getElementById("script-output").innerHTML = e.scriptResult;
		})
		.fail(function() {
			cursorPositionLabel.textContent = "Failed";
			searchButton.textContent = 'Search';
			searchButton.disabled = false;
		})
        .finally(function() {
            stopThreads();
        });
}, false);

function escapeRegExp(str) {
    return str.replace(/[\-\[\]\/\{\}\(\)\*\+\?\.\\\^\$\|]/g, "\\$&");
}
